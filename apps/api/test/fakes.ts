import type { Mailer } from '../src/auth/emails.js';

export type SentEmailKind = 'verification' | 'invite' | 'passwordReset';

export interface SentEmail {
  kind: SentEmailKind;
  to: string;
  token: string;
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

  sentTo(kind: SentEmailKind, to: string): SentEmail | undefined {
    return this.sent.find((m) => m.kind === kind && m.to === to);
  }
}