// Duration clock only. Never persist this value or use it as a distributed deadline.
// Values can be correlated across processes on this same host, not across hosts.
export const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
