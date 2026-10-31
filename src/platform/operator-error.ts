// An error whose message is operator guidance written in code, such as
// "database migrations are pending: <migration names>". Unlike any other
// error, its message reaches the logs (F01), so build it only from fixed text
// and values from the image itself; never from a URL, credential, request,
// query result or provider response.
export class OperatorError extends Error {}
