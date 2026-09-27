import nodemailer from 'nodemailer'

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null

function getTransporter() {
  if (!transporter) {
    const url = process.env.SMTP_URL
    if (!url) throw new Error('SMTP_URL is required')
    transporter = nodemailer.createTransport(url)
  }
  return transporter
}

export async function sendMagicLink(email: string, verifyUrl: string): Promise<void> {
  const t = getTransporter()
  await t.sendMail({
    from: `"Nexolab OpenSpec" <noreply@${new URL(process.env.PUBLIC_BASE_URL ?? 'http://localhost').hostname}>`,
    to: email,
    subject: 'Your magic link to Nexolab OpenSpec',
    text: `Click to sign in: ${verifyUrl}\n\nThis link expires in 15 minutes.`,
    html: `<p>Click to sign in: <a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
  })
}
