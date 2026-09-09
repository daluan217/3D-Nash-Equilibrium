/**
 * Runtime contracts for the five anonymous auth mutations.
 *
 * `dataParsed` only answers whether the transport could decode JSON. These
 * predicates answer the separate question the dialog needs: whether a 2xx
 * body is the success object that the server promises for THIS route.
 */

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasSuccessMessage(value: unknown): value is RecordValue & { success: true; message: string } {
  return isRecord(value) && value.success === true && isNonEmptyString(value.message);
}

export interface LoginSuccess {
  success: true;
  token: string;
  user: { id: string; username: string; email: string };
  localGames?: number;
}

export function isLoginSuccess(value: unknown): value is LoginSuccess {
  if (!isRecord(value) || value.success !== true || !isNonEmptyString(value.token) || !isRecord(value.user)) return false;
  if (!isNonEmptyString(value.user.id) || !isNonEmptyString(value.user.username) || !isNonEmptyString(value.user.email)) return false;
  return value.localGames === undefined
    || (typeof value.localGames === 'number' && Number.isInteger(value.localGames) && value.localGames >= 0);
}

export interface RegisterLocalSuccess {
  success: true;
  message: string;
  autoVerified: true;
}

export interface RegisterHostedSuccess {
  success: true;
  message: string;
  /** Hosted retries may carry false from a compatibility server, but never true. */
  autoVerified?: false;
  email: string;
  via: string;
  previewUrl: string | null;
}

export type RegisterSuccess = RegisterLocalSuccess | RegisterHostedSuccess;

export function isRegisterSuccess(value: unknown): value is RegisterSuccess {
  if (!hasSuccessMessage(value)) return false;
  // The local Electron response is a distinct branch: autoVerified MUST be
  // true, and it has no hosted delivery fields to validate.
  if (value.autoVerified === true) {
    return value.email === undefined && value.via === undefined && value.previewUrl === undefined;
  }

  // Hosted registration always names the recipient/delivery path and always
  // includes previewUrl (SMTP preview URL or null). A bare success/message or
  // autoVerified:false without those fields is not a success object for this
  // route and must not advance the dialog.
  return (value.autoVerified === undefined || value.autoVerified === false)
    && isNonEmptyString(value.email)
    && isNonEmptyString(value.via)
    && Object.prototype.hasOwnProperty.call(value, 'previewUrl')
    && (value.previewUrl === null || isNonEmptyString(value.previewUrl));
}

export interface VerifySuccess {
  success: true;
  message: string;
  username: string;
}

export function isVerifySuccess(value: unknown): value is VerifySuccess {
  return hasSuccessMessage(value) && isNonEmptyString(value.username);
}

export interface ForgotPasswordSuccess {
  success: true;
  message: string;
  recoveryCode?: string;
}

export function isForgotPasswordSuccess(value: unknown): value is ForgotPasswordSuccess {
  if (!hasSuccessMessage(value)) return false;
  return value.recoveryCode === undefined || (typeof value.recoveryCode === 'string' && /^\d{6}$/.test(value.recoveryCode));
}

export interface ResetPasswordSuccess {
  success: true;
  message: string;
}

export function isResetPasswordSuccess(value: unknown): value is ResetPasswordSuccess {
  return hasSuccessMessage(value);
}
