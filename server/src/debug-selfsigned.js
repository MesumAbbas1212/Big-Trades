import selfsigned from "selfsigned";
console.log("selfsigned type:", typeof selfsigned);
console.log("generate:", typeof selfsigned.generate);
const attrs = [{ name: "commonName", value: "localhost" }];
const pems = selfsigned.generate(attrs, { keySize: 2048, days: 365 });
console.log("pems:", JSON.stringify(Object.keys(pems)));
