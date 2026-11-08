# 🐾 NekoTube

Conversor de mídia com tema mágico (site de fãs, sem associação oficial com a Hasbro).

## Requisitos
Node 20+, **FFmpeg e FFprobe** e **yt-dlp** (`pip install yt-dlp`) instalados (`sudo apt install ffmpeg` / `brew install ffmpeg`).

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
- **Importação por link (yt-dlp)**: só de fontes permitidas (`archive.org`, `commons.wikimedia.org`, `upload.wikimedia.org`, `media.ccc.de`; extras via `IMPORT_ALLOWED_HOSTS`). Só `https`, sem IP/porta/credenciais, DNS verificado contra redes privadas (anti-SSRF). A mídia importada entra no mesmo fluxo do upload (opções, progresso, download).
- Links do YouTube: prévia (título, canal, miniatura) via oEmbed, ou Data API se `YOUTUBE_API_KEY` estiver definida (traz a duração). **Não há download de YouTube**: não existe API oficial para isso e o projeto não contorna proteções.

## Expansão
Autenticação de usuários, fila (BullMQ), armazenamento S3, importação por URL de fontes que autorizem expressamente o download (com proteção contra SSRF).

## Arquitetura de processamento
Tudo passa pelo mesmo caminho: **entrada → inspeção (FFprobe) → opções → conversão (FFmpeg) → download**.

| Entrada | Como funciona |
|---|---|
| Arquivo enviado | `POST /api/upload` — extensão + FFprobe validam; limites de tamanho e duração |
| Link de fonte permitida | `POST /api/analyze` (prévia via yt-dlp) → `POST /api/import` (baixa com yt-dlp) → cai no mesmo fluxo do upload |
| Link do YouTube | Só prévia (oEmbed/Data API). Sem download: a plataforma não oferece e o projeto não contorna proteções |

Endpoints: `GET /api/config`, `POST /api/analyze`, `POST /api/upload`, `POST /api/import`, `GET /api/imports/:id`, `POST /api/imports/:id/cancel`,
`POST /api/convert`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`, `GET /api/download/:id`, `GET|DELETE /api/library[/:id]`.

Quando uma fonte não é compatível, o site explica o motivo (fonte fora da lista, exige login, fora do ar, acima dos limites) e **nunca tenta contornar** a restrição.
O envio de arquivos e a conversão funcionam independentemente de qualquer fonte externa ou do yt-dlp estar instalado.

## Testes
`cd backend && npm test` — valida a proteção anti-SSRF, o progresso real, os erros e o cancelamento do importador (sem rede, com yt-dlp simulado).
