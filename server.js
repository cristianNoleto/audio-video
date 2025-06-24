const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ytdl = require('ytdl-core');
const { DownloaderHelper } = require('node-downloader-helper');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const app = express();

// Configurar trust proxy para lidar com X-Forwarded-For
app.set('trust proxy', 1);

// Configurar FFmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);

// Criar pasta Uploads se não existir
const uploadsDir = path.join(__dirname, 'Uploads');
const ensureUploadsDir = async () => {
    try {
        await fs.mkdir(uploadsDir, { recursive: true });
        console.log('Pasta Uploads criada ou já existe.');
    } catch (err) {
        console.error('Erro ao criar pasta Uploads:', err);
    }
};
ensureUploadsDir();

// Configurar multer para uploads com validação de tipo
const upload = multer({
    dest: uploadsDir,
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/ogg',
            'audio/mp4', 'audio/x-ms-wma', 'video/mp4', 'video/x-msvideo', 'video/quicktime'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Formato de arquivo não suportado. Use MP3, WAV, FLAC, AAC, OGG, M4A, WMA, MP4, AVI ou MOV.'));
        }
    },
    limits: { fileSize: 100 * 1024 * 1024 } // Limite de 100MB
});

// Servir arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// Servir arquivos da pasta uploads
app.use('/uploads', express.static(uploadsDir));

// Rota para a página inicial
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Limpar diretório de uploads na inicialização
const clearUploads = async () => {
    try {
        const files = await fs.readdir(uploadsDir);
        for (const file of files) {
            await fs.unlink(path.join(uploadsDir, file)).catch(() => {});
        }
        console.log('Pasta Uploads limpa.');
    } catch (err) {
        console.error('Erro ao limpar uploads:', err);
    }
};
clearUploads();

// Middleware para limitar requisições
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100,
}));
app.use(express.json());

// Validar arquivo baixado
const validateDownloadedFile = async (filePath) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) return reject(err);
                resolve(metadata);
            });
        });
        return metadata.format && metadata.format.duration > 0;
    } catch (err) {
        console.error('Erro ao validar arquivo baixado:', err);
        return false;
    }
};

// Upload de arquivo
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }

        const filePath = req.file.path;
        const duration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) {
                    console.error('Erro no ffprobe:', err);
                    return reject(new Error(`Erro ao processar arquivo: ${err.message}`));
                }
                const duration = metadata.format.duration;
                if (duration > 3600) {
                    return reject(new Error('Arquivo excede 1 hora.'));
                }
                resolve(duration);
            });
        });

        const id = uuidv4();
        const newPath = path.join(uploadsDir, `${id}_${req.file.originalname}`);
        await fs.rename(filePath, newPath);
        res.json({ id, duration });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Download de vídeo de redes sociais
app.post('/download-social', async (req, res) => {
    const { url, format } = req.body;
    if (!url || !format) {
        return res.status(400).json({ error: 'URL e formato são obrigatórios.' });
    }

    const id = uuidv4();
    const tempPath = path.join(uploadsDir, `${id}.mp4`);
    const outputPath = path.join(UploadsDir, `${id}.${format}`);

    try {
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            // Validar URL do YouTube
            if (!ytdl.validateURL(url)) {
                return res.status(400).json({ error: 'URL do YouTube inválida.' });
            }

            const stream = ytdl(url, { quality: format === 'mp4' ? 'highestvideo' : 'highestaudio' });
            ffmpeg(stream)
                .toFormat(format)
                .save(outputPath)
                .on('end', () => {
                    res.json({ url: `/uploads/${path.basename(outputPath)}` });
                })
                .on('error', err => {
                    console.error('Erro no ffmpeg (YouTube):', err);
                    res.status(400).json({ error: `Erro ao processar vídeo: ${err.message}` });
                });
        } else {
            const dl = new DownloaderHelper(url, uploadsDir, { fileName: `${id}.mp4` });
            dl.on('end', async () => {
                // Validar o arquivo baixado
                const isValid = await validateDownloadedFile(tempPath);
                if (!isValid) {
                    await fs.unlink(tempPath).catch(() => {});
                    return res.status(400).json({ error: 'Arquivo baixado é inválido ou corrompido.' });
                }

                ffmpeg(tempPath)
                    .toFormat(format)
                    .save(outputPath)
                    .on('end', () => {
                        res.json({ url: `/uploads/${path.basename(outputPath)}` });
                    })
                    .on('error', err => {
                        console.error('Erro no ffmpeg (outras plataformas):', err);
                        res.status(400).json({ error: `Erro ao processar vídeo: ${err.message}` });
                    });
            });
            dl.on('error', err => {
                console.error('Erro no download:', err);
                res.status(400).json({ error: `Erro ao baixar vídeo: ${err.message}` });
            });
            dl.start();
        }
    } catch (err) {
        console.error('Erro geral no download-social:', err);
        res.status(400).json({ error: err.message });
    }
});

// Melhoria de áudio
app.post('/enhance-audio', async (req, res) => {
    const { fileId } = req.body;
    if (!fileId) {
        return res.status(400).json({ error: 'ID do arquivo é obrigatório.' });
    }

    const inputPath = (await fs.readdir(uploadsDir)).find(f => f.startsWith(fileId));
    if (!inputPath) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }

    const outputPath = path.join(UploadsDir, `${fileId}_enhanced.mp3`);

    try {
        ffmpeg(path.join(UploadsDir, inputPath))
            .audioFilter('afftdn') // Redução de ruído
            .toFormat('mp3')
            .save(outputPath)
            .on('end', () => {
                res.json({ url: `/uploads/${path.basename(outputPath)}` });
            })
            .on('error', err => {
                console.error('Erro no ffmpeg (enhance):', err);
                res.status(400).json({ error: `Erro ao melhorar áudio: ${err.message}` });
            });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Divisão de áudio
app.post('/split-audio', async (req, res) => {
    const { fileId, duration } = req.body;
    if (!fileId || !duration) {
        return res.status(400).json({ error: 'ID do arquivo e duração são obrigatórios.' });
    }

    const inputPath = (await fs.readdir(UploadsDir)).find(f => f.startsWith(fileId));
    if (!inputPath) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }

    const segments = [];

    try {
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(path.join(UploadsDir, inputPath), (err, metadata) => {
                if (err) {
                    console.error('Erro no ffprobe (split):', err);
                    return reject(new Error(`Erro ao processar arquivo: ${err.message}`));
                }
                resolve(metadata);
            });
        });

        const totalDuration = metadata.format.duration;
        for (let i = 0; i < totalDuration; i += duration) {
            const segmentId = uuidv4();
            const segmentPath = path.join(UploadsDir, `${fileId}_segment_${i}.mp3`);
            await new Promise((resolve, reject) => {
                ffmpeg(path.join(UploadsDir, inputPath))
                    .setStartTime(i)
                    .setDuration(duration)
                    .toFormat('mp3')
                    .save(segmentPath)
                    .on('end', resolve)
                    .on('error', err => {
                        console.error('Erro no ffmpeg (split):', err);
                        reject(err);
                    });
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
    if (!fileId || !format) {
        return res.status(400).json({ error: 'ID do arquivo e formato são obrigatórios.' });
    }

    const inputPath = (await fs.readdir(UploadsDir)).find(f => f.startsWith(fileId));
    if (!inputPath) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }

    const outputPath = path.join(UploadsDir, `${fileId}_converted.${format}`);

    try {
        ffmpeg(path.join(UploadsDir, inputPath))
            .toFormat(format)
            .save(outputPath)
            .on('end', () => {
                res.json({ url: `/uploads/${path.basename(outputPath)}` });
            })
            .on('error', err => {
                console.error('Erro no ffmpeg (convert):', err);
                res.status(400).json({ error: `Erro ao converter arquivo: ${err.message}` });
            });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Download de arquivo
app.post('/download-file', async (req, res) => {
    const { fileId, segment } = req.body;
    if (!fileId) {
        return res.status(400).json({ error: 'ID do arquivo é obrigatório.' });
    }

    const filePath = segment
        ? path.join(UploadsDir, segment)
        : (await fs.readdir(UploadsDir)).find(f => f.startsWith(fileId));
    if (!filePath) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }

    res.json({ url: `/uploads/${path.basename(filePath)}` });
});

// Limpar arquivos
app.post('/clear-files', async (req, res) => {
    await clearUploads();
    res.json({ status: 'ok' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
