export type AgentEndpoint = {
  ip: string;
  port: number;
};

export type TrustedAgentIdentity = {
  spkiPin: string;
};

export const isValidPort = (value: unknown): value is number => {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
};

export const isPrivateIpv4Address = (value: string): boolean => {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map((part) => Number(part));

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const first = octets[0];
  const second = octets[1];

  if (first === undefined || second === undefined) {
    return false;
  }

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

export const formatAgentWebSocketUrl = (endpoint: AgentEndpoint): string => {
  return `wss://${endpoint.ip}:${endpoint.port}`;
};
