# Publicando o NekoTube

Site (frontend) no **GitHub Pages** + API (backend) no **Render** (grátis, via Docker).

## 1. Subir o código no GitHub
1. Crie um repositório (ex.: `nekotube`) em github.com/new.
2. Envie **o conteúdo desta pasta** (backend, frontend, .github, render.yaml…) para a branch `main`.
   Pelo site: "uploading an existing file" e arraste tudo (inclusive a pasta `.github`).

## 2. Backend no Render
1. Em render.com, entre com o GitHub → **New → Blueprint** → escolha o repositório.
2. Em `FRONTEND_ORIGIN`, coloque o endereço do seu site: `https://SEU-USUARIO.github.io`
   (somente o domínio, sem `/nekotube` e sem barra no final).
3. Aguarde o deploy. Copie a URL gerada (ex.: `https://nekotube-api.onrender.com`).
   Teste abrindo `SUA-URL/api/config`: deve aparecer `"ffmpeg":true`.

## 3. Frontend no GitHub Pages
1. No repositório: **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → aba Variables → New variable**
   Nome `API_URL`, valor = a URL do Render (sem barra no final).
3. Em **Actions**, rode "Publicar frontend" (ou faça um novo commit).
   O site ficará em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

## Limites do plano grátis
- O Render "dorme" após ~15 min parado: o primeiro acesso demora ~1 min.
- CPU fraca: vídeos longos convertem devagar. Disco temporário (a biblioteca zera ao reiniciar).
- Para uso mais sério, use um plano pago ou um VPS com o mesmo Dockerfile.

## Teste local com Docker
```bash
cd backend && docker build -t nekotube-api . && docker run -p 3001:3001 -e FRONTEND_ORIGIN=http://localhost:5173 nekotube-api
```
