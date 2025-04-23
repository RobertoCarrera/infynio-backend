import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import { fromEnv } from "@aws-sdk/credential-provider-env";
import dotenv from "dotenv";

const testClient = new S3Client({
  region: "eu-south-2",
  credentials: fromEnv()
});

dotenv.config(); // ← Añadir esto

async function testCredentials() {
  try {
    const data = await testClient.send(new ListBucketsCommand({}));
    console.log("✅ Credenciales válidas. Buckets encontrados:", data.Buckets);
  } catch (error) {
    console.error("❌ Error de credenciales:", error.message);
  }
}

testCredentials();