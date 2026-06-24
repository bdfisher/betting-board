import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base must match your GitHub repo name exactly (served at /<repo>/ on Pages)
export default defineConfig({
  plugins: [react()],
  base: '/betting-board/',
})
