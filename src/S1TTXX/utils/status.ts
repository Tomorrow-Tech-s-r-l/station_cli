import {
  STATUS_OK,
  STATUS_TIMEOUT,
  STATUS_ERR_INVALID_CMD,
  STATUS_ERR_INTERNAL,
  STATUS_ERR_INVALID_RESPONSE,
  STATUS_ERR_INVALID_ARGS,
} from "../protocol/constants";

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
