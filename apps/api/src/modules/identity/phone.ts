import isValid from 'libphonenumber-js';
import { parsePhoneNumber } from 'libphonenumber-js';

import { badRequest } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

export interface ParsedPhone {
  phone: string;
  country: string;
}

export function parsePhone(e164: string): ParsedPhone {
  const phone = e164.trim();
  if (!isValid(phone)) {
    logger.warn({ reason: 'format' }, 'identity.phone-invalid');
    throw badRequest('INVALID_PHONE', 'Phone must be in E.164 format (e.g., +447911123456)');
  }
  const parsed = parsePhoneNumber(phone);
  if (!parsed || !parsed.country) {
    logger.warn({ reason: 'country' }, 'identity.phone-invalid');
    throw badRequest('INVALID_PHONE', 'Unable to determine country for this phone number');
  }
  return { phone: parsed.number, country: parsed.country };
}
