# Asymmetric key query runtime

This small standard-syscall consumer adds a public RSA certificate as an
`asymmetric` key and queries its supported operations and size fields with
`KEYCTL_PKEY_QUERY`. It checks that all reserved output words are zero and
that the reserved syscall argument is rejected before either pointer is read.

The checked-in DER file contains only a self-signed public certificate. To
generate an equivalent test certificate with OpenSSL, use:

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout private.pem -out public.pem -days 3650 \
  -subj '/CN=Generic Linux PKEY query test'
openssl x509 -in public.pem -outform DER -out test-certificate.der
```

The generated private key is only needed while creating a self-signed
certificate. It is not part of this test package.
