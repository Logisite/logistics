import { getConfig, isProd } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

import { sha256Hex } from './hash.js';

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

export class TwilioSmsProvider implements SmsProvider {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;

  constructor() {
    const config = getConfig();
    if (!config.smsAccountSid || !config.smsAuthToken || !config.smsFromNumber) {
      logger.error('identity.sms-not-configured');
      throw new Error('Twilio SMS requires SMS_ACCOUNT_SID, SMS_AUTH_TOKEN, and SMS_FROM_NUMBER');
    }
    this.accountSid = config.smsAccountSid;
    this.authToken = config.smsAuthToken;
    this.fromNumber = config.smsFromNumber;
  }

  async sendOtp(phone: string, code: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const body = new URLSearchParams({
      To: phone,
      From: this.fromNumber,
      Body: `Your verification code is: ${code}. It expires in 5 minutes.`,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error(
        { phoneHash: sha256Hex(phone), smsStatus: response.status },
        'identity.sms-send-failed',
      );
      throw new Error(`Twilio SMS failed (${response.status}): ${error}`);
    }
  }
}

export class FakeSmsProvider implements SmsProvider {
  private _lastPhone: string | undefined;
  private _lastCode: string | undefined;

  async sendOtp(phone: string, code: string): Promise<void> {
    this._lastPhone = phone;
    this._lastCode = code;
  }

  get lastPhone(): string | undefined {
    return this._lastPhone;
  }

  get lastCode(): string | undefined {
    return this._lastCode;
  }
}

export function createSmsProvider(): SmsProvider {
  const config = getConfig();
  if (config.smsAccountSid && config.smsAuthToken && config.smsFromNumber) {
    return new TwilioSmsProvider();
  }
  if (isProd) {
    logger.error('identity.sms-not-configured');
    throw new Error(
      'SMS provider not configured. Set SMS_ACCOUNT_SID, SMS_AUTH_TOKEN, and SMS_FROM_NUMBER.',
    );
  }
  return new FakeSmsProvider();
}
