import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alta",
  description: "Build a voice agent by chat.",
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
