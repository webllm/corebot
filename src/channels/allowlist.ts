const splitIdentity = (value: string) => {
  const trimmed = value.trim();
  const pipeAt = trimmed.indexOf("|");
  if (pipeAt <= 0) {
    return {
      raw: trimmed,
      idPart: trimmed,
      userPart: ""
    };
  }
  return {
    raw: trimmed,
    idPart: trimmed.slice(0, pipeAt),
    userPart: trimmed.slice(pipeAt + 1)
  };
};

const normalizeAllowed = (value: string) => value.trim().replace(/^@/, "");

export const isChannelIdentityAllowed = (
  allowlist: string[],
  identity: string
): boolean => {
  if (allowlist.length === 0) {
    return true;
  }

  const sender = splitIdentity(identity);
  for (const entry of allowlist) {
    const allowedRaw = entry.trim();
    if (!allowedRaw) {
      continue;
    }

    const allowedTrimmed = normalizeAllowed(allowedRaw);
    const allowed = splitIdentity(allowedTrimmed);

    if (
      sender.raw === allowedRaw ||
      sender.idPart === allowedRaw ||
      sender.raw === allowedTrimmed ||
      sender.idPart === allowedTrimmed ||
      sender.idPart === allowed.idPart ||
      (allowed.userPart !== "" && sender.raw === allowed.userPart) ||
      (sender.userPart !== "" &&
        (sender.userPart === allowedRaw ||
          sender.userPart === allowedTrimmed ||
          sender.userPart === allowed.userPart))
    ) {
      return true;
    }
  }

  return false;
};
