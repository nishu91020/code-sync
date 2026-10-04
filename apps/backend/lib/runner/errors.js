/** An execution failure with the HTTP status the API should answer with. */
export class RunnerError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'RunnerError'
    this.status = status
  }
}
