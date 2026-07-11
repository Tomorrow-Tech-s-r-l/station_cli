import {
  STATUS_OK,
  STATUS_TIMEOUT,
  STATUS_ERR_INVALID_CMD,
  STATUS_ERR_INTERNAL,
  STATUS_ERR_INVALID_RESPONSE,
  STATUS_ERR_INVALID_ARGS,
} from "../../utils/constants";

export const getStatusMessage = (status: number): string => {
  switch (status) {
    case STATUS_OK:
      return "Command successful";
    case STATUS_TIMEOUT:
      return "Device timeout - device not responding";
    case STATUS_ERR_INVALID_CMD:
      return "Invalid command - command not supported";
    case STATUS_ERR_INVALID_ARGS:
      return "Invalid arguments - check command parameters";
    case STATUS_ERR_INTERNAL:
      return "Internal device error - device may need reset";
    case STATUS_ERR_INVALID_RESPONSE:
      return "Invalid response format from device";
    default:
      return `Unknown error (code: ${status})`;
  }
};

/**
 * Stable, greppable token for a protocol status — the machine-readable
 * counterpart to {@link getStatusMessage}. Unlike the numeric `code` or the
 * human `message`, these strings are safe to alert/group on and stay constant
 * across builds. Consumers must tolerate an unknown `ERR_UNKNOWN_*` value.
 */
export const getStatusCode = (status: number): string => {
  switch (status) {
    case STATUS_OK:
      return "OK";
    case STATUS_TIMEOUT:
      return "TIMEOUT";
    case STATUS_ERR_INVALID_CMD:
      return "ERR_INVALID_CMD";
    case STATUS_ERR_INVALID_ARGS:
      return "ERR_INVALID_ARGS";
    case STATUS_ERR_INTERNAL:
      return "ERR_INTERNAL";
    case STATUS_ERR_INVALID_RESPONSE:
      return "ERR_INVALID_RESPONSE";
    default:
      return `ERR_UNKNOWN_${status}`;
  }
};
