/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        rh: {
          bg:        '#0F0F11',
          card:      '#16161A',
          card2:     '#1C1C21',
          border:    '#2A2A30',
          border2:   '#38383F',
          accent:    '#E52128',
          'accent-h':'#FF2D35',
          muted:     '#6B6B7A',
          text:      '#E8E8F0',
          'text-dim':'#9999AA',
        },
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
