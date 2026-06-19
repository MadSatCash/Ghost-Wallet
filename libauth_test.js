(context, { coveredBytecode, signingSerializationType, }, sha256 = internalSha256) => encodeSigningSerializationBCH({
    ...generateSigningSerializationComponentsBCH(context),
    coveredBytecode,
    signingSerializationType,
}, sha256)