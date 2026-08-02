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

const siteUrl = process.env.SITE_URL

export const metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: "Danini's Bookshelf",
  description: 'A warm reading corner for learning English, one word at a time.',
  manifest: siteUrl ? '/bookshelf/site.webmanifest' : '/site.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: "Danini's Bookshelf",
  },
  icons: {
    icon: siteUrl
      ? [
          { url: '/bookshelf/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
          { url: '/bookshelf/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
        ]
      : [
          { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
          { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
        ],
    shortcut: siteUrl ? '/bookshelf/favicon.ico' : '/favicon.ico',
    apple: siteUrl ? '/bookshelf/apple-touch-icon.png' : '/apple-touch-icon.png',
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
