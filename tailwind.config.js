/** @type {import('tailwindcss').Config} */
export default {
  content: [
      "./public/**/*.html", 
      "./public/js/**/*.js"
    ],
  theme: {
    extend: {
      colors: {
        // True neutral grays (equal-ish R/G/B), replacing Tailwind's default
        // blue-leaning "gray" (really a slate) so every bg-gray-*/border-gray-*/
        // text-gray-*/divide-gray-* class already in the app reads correctly
        // against the redesign's warm near-black palette instead of blue.
        gray: {
          50: '#FAFAFA',
          100: '#F0F0F1',
          200: '#E0E0E1',
          300: '#C6C6CA',
          400: '#9A9A9E',
          500: '#6C6C70',
          600: '#4A4A4D',
          700: '#333335',
          800: '#222224',
          900: '#18181A',
          950: '#0F0F10',
        },
        mar: '#7B1D2B',
        'mar-l': '#A6303F',
        'mar-d': '#4E101B',
        gold: '#E0B863',
        'gold-l': '#F3DCA9',
        'gold-d': '#B8893A',
        ink: '#1A1A1C',
        mute: '#6C6C70',
        ok: '#2E9E63',
        warn: '#D9503C',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}