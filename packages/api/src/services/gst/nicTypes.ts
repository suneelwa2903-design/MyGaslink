/**
 * Shared NIC / WhiteBooks API wire-shape types.
 *
 * These describe the JSON envelopes WhiteBooks (the GSP) returns when
 * proxying NIC's e-Invoice (IRN) and e-Way Bill (EWB) endpoints. WhiteBooks
 * is notoriously loose with field naming — the same datum arrives under
 * several conventions (PascalCase IRN-style, camelCase EWB-style, nested
 * under `data`, or occasionally as a top-level field). The interfaces here
 * model that as broadly-optional fields so the parsing helpers in
 * gstService.ts / payloadBuilders.ts can probe each known path.
 *
 * Introduced as part of the post-launch typing pass (replacing `any` on the
 * GST integration). The runtime parsing logic is unchanged — these types
 * only describe the shapes the code already reads.
 */

/**
 * The common WhiteBooks success/failure envelope. `status_cd` is '1' / 1 /
 * 'Sucess' (their typo) / 'Success' on success; `status_desc` carries either
 * a human message or a JSON-encoded array of NIC `{ ErrorCode, ErrorMessage }`
 * objects on failure. EWB-style errors arrive under `error` instead.
 */
export interface WhiteBooksEnvelope {
  status_cd?: string | number;
  status_desc?: string;
  error?: {
    message?: string;
    error_cd?: string;
  };
  data?: unknown;
}

/** A single NIC error object as it appears inside a JSON-encoded status_desc. */
export interface NicError {
  ErrorCode?: string;
  ErrorMessage?: string;
}

/** The `data` block of an EWB error message JSON (parsed from error.message). */
export interface EwbErrorBody {
  errorCodes?: string | number;
  message?: string;
}

/** Auth (`/authenticate`) response data block. */
export interface AuthResponseData {
  AuthToken?: string;
  authtoken?: string;
  TokenExpiry?: string;
}

export interface AuthResponse extends WhiteBooksEnvelope {
  data?: AuthResponseData;
}

/**
 * IRN GENERATE / GETIRN response data block. WhiteBooks sometimes hoists
 * these fields to the top level too, so the consuming code reads both
 * `resp.data?.X` and `resp.X`.
 */
export interface IrnResponseData {
  Irn?: string;
  irn?: string;
  AckNo?: string | number;
  ackNo?: string | number;
  AckDt?: string;
  ackDate?: string;
  SignedQRCode?: string;
  signedQr?: string;
  // EWB fields NIC sometimes returns alongside an IRN.
  EwbNo?: string | number;
  ewbNo?: string | number;
  EwbDt?: string;
  ewbDt?: string;
  EwbValidTill?: string;
  ewbValidTill?: string;
  validFrom?: string;
  validTo?: string;
}

/** Full IRN envelope: fields appear under `data` and/or at the top level. */
export interface IrnResponse extends WhiteBooksEnvelope, IrnResponseData {
  data?: IrnResponseData;
}

/** EWB genewaybill response data block (multiple naming conventions). */
export interface EwbResponseData {
  ewayBillNo?: string | number;
  ewbNo?: string | number;
  EwbNo?: string | number;
  ewayBillDate?: string;
  EwayBillDate?: string;
  validFrom?: string;
  ValidFrom?: string;
  validUpto?: string;
  ValidUpto?: string;
  validTo?: string;
  ValidTo?: string;
}

/**
 * EWB envelope. `data` may be an object, a JSON-encoded string of the body,
 * or (rarely) a raw numeric string of the EWB number. The parsing helper
 * also probes top-level variants.
 */
export interface EwbResponse extends WhiteBooksEnvelope, EwbResponseData {
  data?: EwbResponseData | string;
}

/** Consolidated EWB (gencewb) response. `data` is loose across sandbox builds. */
export interface ConsolidatedEwbResponse extends WhiteBooksEnvelope {
  data?:
    | string
    | number
    | {
        cEwbNo?: string | number;
        tripSheetNo?: string | number;
        consolidatedEwbNo?: string | number;
      };
}
