import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alta-Vibe",
  description: "Vibe-code your ElevenLabs voice agent in plain English.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
