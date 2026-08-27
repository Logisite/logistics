import isValid from 'libphonenumber-js';
import { parsePhoneNumber } from 'libphonenumber-js';

import { badRequest } from '../errors.js';

export interface ParsedPhone {
  phone: string;
  country: string;
}

export function parsePhone(e164: string): ParsedPhone {
  const phone = e164.trim();
  if (!isValid(phone)) {
    throw badRequest('INVALID_PHONE', 'Phone must be in E.164 format (e.g., +447911123456)');
  }
  const parsed = parsePhoneNumber(phone);
  if (!parsed || !parsed.country) {
    throw badRequest('INVALID_PHONE', 'Unable to determine country for this phone number');
  }
  return { phone: parsed.number, country: parsed.country };
}
