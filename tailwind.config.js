/** @type {import('tailwindcss').Config} */
export default {
  // hover: only applies on devices that can actually hover, so taps don't leave
  // rows stuck in their hover color. Touch feedback comes from active: instead.
  future: { hoverOnlyWhenSupported: true },
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
}
