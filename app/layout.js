import { Fraunces, Inter } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import SWRegister from './sw-register'

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const isGH = process.env.GITHUB_PAGES === 'true'
const prefix = isGH ? '/bookshelf' : ''

export const metadata = {
  title: "Danini's Bookshelf",
  description: 'A warm reading corner for learning English, one word at a time.',
  manifest: `${prefix}/site.webmanifest`,
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: "Danini's Bookshelf",
  },
  icons: {
    icon: [
      { url: `${prefix}/favicon-32x32.png`, sizes: '32x32', type: 'image/png' },
      { url: `${prefix}/favicon-16x16.png`, sizes: '16x16', type: 'image/png' },
    ],
    shortcut: `${prefix}/favicon.ico`,
    apple: `${prefix}/apple-touch-icon.png`,
  },
}

export const viewport = {
  themeColor: '#F5E6D3',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body className="font-sans antialiased">
        {children}
        <SWRegister />
        <Toaster position="top-center" />
      </body>
    </html>
  )
}
