import selfsigned from "selfsigned";
import { writeFileSync } from "fs";

const attrs = [{ name: "commonName", value: "localhost" }];
const pems = selfsigned.generate(attrs, {
  keySize: 2048,
  days: 365,
  algorithm: "sha256",
  extensions: [
    { name: "basicConstraints", cA: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 2, value: "127.0.0.1" },
      ],
    },
  ],
});

writeFileSync("cert.pem", pems.cert);
writeFileSync("key.pem", pems.private);
console.log("Generated cert.pem and key.pem");
