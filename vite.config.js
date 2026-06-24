import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Change '/bet-board/' to match your GitHub repo name exactly
export default defineConfig({
  plugins: [react()],
  base: '/bet-board/',
})
