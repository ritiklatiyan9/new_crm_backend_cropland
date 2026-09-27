import { validateGstin, GST_STATE_CODES } from './gst/stateCodes.js';

const str = (v) => String(v ?? '').trim();
export function vendorProfile(input) {
  const name = str(input.name), gstin = str(input.gstin).toUpperCase();
  const pan = str(input.pan).toUpperCase() || (gstin ? gstin.slice(2, 12) : '');
  const pincode = str(input.pincode), phone = str(input.phone), email = str(input.email);
  if (!name) throw new Error('Supplier legal name is required');
  if (gstin) { const check = validateGstin(gstin); if (!check.valid) throw new Error(`GSTIN: ${check.reason}`); }
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw new Error('PAN must contain 5 letters, 4 digits and 1 letter');
  if (gstin && pan !== gstin.slice(2, 12)) throw new Error('PAN must match the PAN in the GSTIN');
  if (pincode && !/^[1-9]\d{5}$/.test(pincode)) throw new Error('Enter a valid 6-digit PIN code');
  if (phone && (!/^\+?[\d\s().-]+$/.test(phone) || !/^\d{7,15}$/.test(phone.replace(/\D/g, '')))) throw new Error('Enter a valid telephone number, including country/area code if needed');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address');
  const defaults = input.invoiceDefaults ?? {};
  if (typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('Invalid invoice defaults');
  const invoiceDefaults = Object.fromEntries(['transport', 'vehicleNo', 'station', 'placeOfSupply', 'terms', 'copyLabel'].map((key) => [key, str(defaults[key]).slice(0, key === 'terms' ? 5000 : 200)]));
  invoiceDefaults.reverseCharge = defaults.reverseCharge === true;
  invoiceDefaults.copyLabel ||= 'Original Copy';
  if (!['Original Copy', 'Duplicate Copy', 'Triplicate Copy'].includes(invoiceDefaults.copyLabel)) throw new Error('Select a valid copy label');
  return { name, gstin: gstin || null, pan: pan || null, pincode: pincode || null, phone: phone || null, email: email || null,
    state: str(input.state) || GST_STATE_CODES[gstin.slice(0, 2)] || null, invoiceDefaults };
}
