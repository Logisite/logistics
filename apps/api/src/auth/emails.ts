import { Resend } from 'resend';

import { getConfig } from '../shared/config.js';

export interface Mailer {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  sendInviteEmail(to: string, token: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string): Promise<void>;
  sendNotificationEmail(to: string, subject: string, body: string): Promise<void>;
}

export class ResendMailer implements Mailer {
  private readonly resend: Resend;
  private readonly appUrl: string;
  private readonly from: string;

  constructor() {
    const config = getConfig();
    this.resend = new Resend(config.resendApiKey);
    this.appUrl = config.appUrl;
    this.from = config.mailFrom;
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

  async sendNotificationEmail(to: string, subject: string, body: string): Promise<void> {
    await this.resend.emails.send({ from: this.from, to, subject, text: body });
  }
}
