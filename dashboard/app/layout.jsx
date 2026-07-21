import './globals.css';

export const metadata = {
  title: 'SigNoz Governor',
  description: 'Day 1 shell — real design pass lands Day 4',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
