import { Resend } from 'resend';

export interface Mailer {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  sendInviteEmail(to: string, token: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string): Promise<void>;
}

export class ResendMailer implements Mailer {
  private readonly resend: Resend;
  private readonly appUrl: string;
  private readonly from: string;

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
    this.appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    this.from = process.env.MAIL_FROM ?? 'Logisite <auth@logisite.ng>';
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Verify your email',
      text: `Verify your email: ${this.appUrl}/verify-email?token=${token}`,
    });
  }

  async sendInviteEmail(to: string, token: string): Promise<void> {
    await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'You were invited to Logisite',
      text: `Set your password: ${this.appUrl}/set-password?token=${token}`,
    });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Reset your password',
      text: `Reset your password: ${this.appUrl}/reset-password?token=${token}`,
    });
  }
}