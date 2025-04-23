import { S3Client } from "@aws-sdk/client-s3";
import dotenv from 'dotenv';

dotenv.config();

// Configuración avanzada del cliente S3
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  // Opciones adicionales para evitar timeouts
  requestHandler: {
    connectionTimeout: 5000,
    requestTimeout: 10000
  }
});

console.log("Región configurada:", process.env.AWS_REGION);
console.log("Cliente S3 inicializado:", !!s3Client);

export default s3Client;