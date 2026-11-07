# 🐾 NekoTube

Conversor de mídia com tema mágico (site de fãs, sem associação oficial com a Hasbro).

## Requisitos
Node 20+, **FFmpeg e FFprobe** instalados (`sudo apt install ffmpeg` / `brew install ffmpeg`).

## Rodando
```bash
cd backend && cp .env.example .env && npm install && npm start     # API :3001
cd frontend && npm start                                            # site :5173
```
Em produção, ajuste `FRONTEND_ORIGIN` (backend) e `frontend/config.js` (URL da API).

## O que é real
- Upload validado (extensão + FFprobe), limites de tamanho/duração, nomes aleatórios no disco.
- Conversão real com FFmpeg: MP3/WAV/M4A e MP4 360–1080p (apenas as qualidades ≤ resolução do arquivo).
- Progresso real, cancelamento, download pelo navegador, biblioteca em SQLite (por navegador).
- Limpeza automática: arquivos expiram após `FILE_TTL_MIN` minutos; órfãos são removidos ao iniciar.
- Links do YouTube: prévia (título, canal, miniatura) via oEmbed, ou Data API se `YOUTUBE_API_KEY` estiver definida (traz a duração). **Não há download de YouTube**: não existe API oficial para isso e o projeto não contorna proteções.

## Expansão
Autenticação de usuários, fila (BullMQ), armazenamento S3, importação por URL de fontes que autorizem expressamente o download (com proteção contra SSRF).
