/** @type {import('tailwindcss').Config} */
export default {
  content: [
      "./public/**/*.html", 
      "./public/js/**/*.js"
    ],
  theme: {
    extend: {
      colors: {
        primary: '#572932',
        secondary: '#3C1A22',
        accent: '#FDE047',
        'admin-bg': '#3F3F46',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
}