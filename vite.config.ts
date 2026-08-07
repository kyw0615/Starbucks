import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages는 https://<user>.github.io/<repo>/ 하위 경로로 서빙되므로
// 빌드 시 base를 리포지토리 이름으로 맞춰야 한다.
// GitHub Actions가 BASE_PATH 환경변수를 주입한다 (로컬 dev는 '/').
const base = process.env.BASE_PATH ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
})
