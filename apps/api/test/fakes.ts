import type { Mailer } from '../src/auth/emails.js';

export type SentEmailKind = 'verification' | 'invite' | 'passwordReset' | 'notification';

export interface SentEmail {
  kind: SentEmailKind;
  to: string;
  token?: string;
  subject?: string;
  body?: string;
}

export class FakeMailer implements Mailer {
  sent: SentEmail[] = [];

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    this.sent.push({ kind: 'verification', to, token });
  }

  async sendInviteEmail(to: string, token: string): Promise<void> {
    this.sent.push({ kind: 'invite', to, token });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    this.sent.push({ kind: 'passwordReset', to, token });
  }

  async sendNotificationEmail(to: string, subject: string, body: string): Promise<void> {
    this.sent.push({ kind: 'notification', to, subject, body });
  }

  sentTo(kind: SentEmailKind, to: string): SentEmail | undefined {
    return this.sent.find((m) => m.kind === kind && m.to === to);
  }

  notificationsTo(to: string): SentEmail[] {
    return this.sent.filter((m) => m.kind === 'notification' && m.to === to);
  }
}