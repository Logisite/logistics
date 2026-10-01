import { Resend } from 'resend';

import { getConfig } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

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

  private async send(to: string, subject: string, text: string, purpose: string): Promise<void> {
    const { error } = await this.resend.emails.send({ from: this.from, to, subject, text });
    if (error) {
      logger.error({ err: error, purpose }, 'auth.email-send-failed');
      throw error;
    }
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    await this.send(to, 'Verify your email', `Verify your email: ${this.appUrl}/verify-email?token=${token}`, 'verification');
  }

  async sendInviteEmail(to: string, token: string): Promise<void> {
    await this.send(to, 'You were invited to Logisite', `Set your password: ${this.appUrl}/set-password?token=${token}`, 'invite');
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    await this.send(to, 'Reset your password', `Reset your password: ${this.appUrl}/reset-password?token=${token}`, 'password_reset');
  }

  async sendNotificationEmail(to: string, subject: string, body: string): Promise<void> {
    await this.send(to, subject, body, 'notification');
  }
}
