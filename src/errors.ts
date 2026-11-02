/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * Based on openschoolcn/zfn_api: https://github.com/openschoolcn/zfn_api
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
