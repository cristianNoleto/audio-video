const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('ytdl-core');
const { DownloaderHelper } = require('node-downloader-helper');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const app = express();
const upload = multer({ dest: 'uploads/' });
const port = process.env.PORT || 3000;

// Configurar FFmpeg
ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);

// Servir arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// Servir arquivos da pasta uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Middleware para limitar requisições
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100,
}));
app.use(express.json());

// Limpar diretório de uploads na inicialização
const clearUploads = async () => {
    const files = await fs.readdir('uploads');
    for (const file of files) {
        await fs.unlink(path.join('uploads', file)).catch(() => {});
    }
};
clearUploads();

// Rota para servir o index.html na raiz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload de arquivo
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const filePath = req.file.path;
        const duration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) return reject(err);
                const duration = metadata.format.duration;
                if (duration > 3600) return reject(new Error('Arquivo excede 1 hora'));
                resolve(duration);
            });
        });
        const id = uuidv4();
        const newPath = path.join('uploads', `${id}_${req.file.originalname}`);
        await fs.rename(filePath, newPath);
        res.json({ id, duration });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Download de vídeo de redes sociais
app.post('/download-social', async (req, res) => {
    const { url, format } = req.body;
    const id = uuidv4();
    const outputPath = path.join('uploads', `${id}.${format}`);

    try {
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            const stream = ytdl(url, { quality: format === 'mp4' ? 'highestvideo' : 'highestaudio' });
            ffmpeg(stream)
                .toFormat(format)
                .save(outputPath)
                .on('end', () => {
                    res.json({ url: `/uploads/${path.basename(outputPath)}` });
                })
                .on('error', err => {
                    res.status(400).json({ error: err.message });
                });
        } else {
            const dl = new DownloaderHelper(url, 'uploads', { fileName: `${id}.mp4` });
            dl.on('end', () => {
                ffmpeg(path.join('uploads', `${id}.mp4`))
                    .toFormat(format)
                    .save(outputPath)
                    .on('end', () => {
                        res.json({ url: `/uploads/${path.basename(outputPath)}` });
                    })
                    .on('error', err => {
                        res.status(400).json({ error: err.message });
                    });
            });
            dl.start();
        }
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Melhoria de áudio
app.post('/enhance-audio', async (req, res) => {
    const { fileId } = req.body;
    const inputPath = (await fs.readdir('uploads')).find(f => f.startsWith(fileId));
    const outputPath = path.join('uploads', `${fileId}_enhanced.mp3`);

    try {
        ffmpeg(path.join('uploads', inputPath))
            .audioFilter('afftdn') // Redução de ruído
            .toFormat('mp3')
            .save(outputPath)
            .on('end', () => {
                res.json({ url: `/uploads/${path.basename(outputPath)}` });
            })
            .on('error', err => {
                res.status(400).json({ error: err.message });
            });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Divisão de áudio
app.post('/split-audio', async (req, res) => {
    const { fileId, duration } = req.body;
    const inputPath = (await fs.readdir('uploads')).find(f => f.startsWith(fileId));
    const segments = [];

    try {
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(path.join('uploads', inputPath), (err, metadata) => {
                if (err) return reject(err);
                resolve(metadata);
            });
        });
        const totalDuration = metadata.format.duration;
        for (let i = 0; i < totalDuration; i += duration) {
            const segmentId = uuidv4();
            const segmentPath = path.join('uploads', `${fileId}_segment_${i}.mp3`);
            await new Promise((resolve, reject) => {
                ffmpeg(path.join('uploads', inputPath))
                    .setStartTime(i)
                    .setDuration(duration)
                    .toFormat('mp3')
                    .save(segmentPath)
                    .on('end', resolve)
                    .on('error', reject);
            });
            segments.push(path.basename(segmentPath));
        }
        res.json({ segments });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Conversão de formato
app.post('/convert', async (req, res) => {
    const { fileId, format } = req.body;
    const inputPath = (await fs.readdir('uploads')).find(f => f.startsWith(fileId));
    const outputPath = path.join('uploads', `${fileId}_converted.${format}`);

    try {
        ffmpeg(path.join('uploads', inputPath))
            .toFormat(format)
            .save(outputPath)
            .on('end', () => {
                res.json({ url: `/uploads/${path.basename(outputPath)}` });
            })
            .on('error', err => {
                res.status(400).json({ error: err.message });
            });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Download de arquivo
app.post('/download-file', async (req, res) => {
    const { fileId, segment } = req.body;
    const filePath = segment
        ? path.join('uploads', segment)
        : (await fs.readdir('uploads')).find(f => f.startsWith(fileId));
    res.json({ url: `/uploads/${path.basename(filePath)}` });
});

// Limpar arquivos
app.post('/clear-files', async (req, res) => {
    await clearUploads();
    res.json({ status: 'ok' });
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
