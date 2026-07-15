export type AddressFamily = 4 | 6;

export type AgentEndpoint = {
  family: AddressFamily;
  /** `"192.168.1.10"` for family 4, `"fd00::1"` for family 6 (no brackets, no zone id). */
  address: string;
  port: number;
};

export const isValidPort = (value: unknown): value is number => {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
};

const ipv4Octets = (value: string): number[] | null => {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number(part));

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
};

export const isPrivateIpv4Address = (value: string): boolean => {
  const octets = ipv4Octets(value);

  if (!octets) {
    return false;
  }

  const first = octets[0];
  const second = octets[1];

  if (first === undefined || second === undefined) {
    return false;
  }

  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
};

export const isLoopbackIpv4Address = (value: string): boolean => {
  const octets = ipv4Octets(value);

  return octets !== null && octets[0] === 127;
};

export const isLocalIpv4Address = (value: string): boolean => {
  return isPrivateIpv4Address(value) || isLoopbackIpv4Address(value);
};

/** Unique local address (`fc00::/7`, includes the commonly-used `fd00::/8`). */
export const isUniqueLocalIpv6Address = (value: string): boolean => {
  const normalized = value.toLowerCase();

  return /^f[cd][0-9a-f]{2}:/.test(normalized);
};

export const isLinkLocalIpv6Address = (value: string): boolean => {
  return /^fe80:/i.test(value);
};

export const isLoopbackIpv6Address = (value: string): boolean => {
  return value === "::1";
};

export const isLocalIpv6Address = (value: string): boolean => {
  return isLoopbackIpv6Address(value) || isUniqueLocalIpv6Address(value) || isLinkLocalIpv6Address(value);
};

export const isLocalAddress = (endpoint: Pick<AgentEndpoint, "family" | "address">): boolean => {
  return endpoint.family === 4 ? isLocalIpv4Address(endpoint.address) : isLocalIpv6Address(endpoint.address);
};

/** Bracket IPv6 literals: `wss://[fd00::1]:8443`; plain form for IPv4: `wss://192.168.1.10:8443`. */
export const formatAgentWebSocketUrl = (endpoint: AgentEndpoint): string => {
  const host = endpoint.family === 6 ? `[${endpoint.address}]` : endpoint.address;

  return `wss://${host}:${endpoint.port}`;
};
