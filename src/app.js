import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid'; // Importar uuid
import { 
  ListBucketsCommand, 
  CreateBucketCommand, 
  HeadBucketCommand, 
  DeleteBucketCommand, 
  ListObjectsV2Command,
  GetBucketLocationCommand,
  PutBucketWebsiteCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  PutBucketCorsCommand
} from "@aws-sdk/client-s3";
import { 
  LightsailClient, 
  GetInstancesCommand, 
  CreateInstancesCommand, 
  GetBundlesCommand, 
  GetBlueprintsCommand ,
  GetInstanceCommand,
  CreateKeyPairCommand
} from "@aws-sdk/client-lightsail";
import s3Client from "./config/aws-config.js";
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configuración de CORS para desarrollo
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS.split(','),
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// --- Configuración del Cliente Lightsail ---
// Utiliza la misma configuración de credenciales y región que para S3
const lightsailClient = new LightsailClient({
  region: process.env.LIGHTSAIL_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  // Puedes añadir opciones adicionales si son necesarias para Lightsail
});

async function isBucketNameAvailable(bucketName) {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    return false; // Existe
  } catch (error) {
    return error.name === 'NotFound'; // No existe
  }
}

app.get('/api/buckets', async (req, res) => {
  try {
    const data = await s3Client.send(new ListBucketsCommand({}));
    const buckets = data.Buckets.map(bucket => ({
      name: bucket.Name,
      creationDate: bucket.CreationDate,
      endpoint: `http://${bucket.Name}.s3-website.${process.env.AWS_REGION}.amazonaws.com`
    }));
    res.json({ buckets });
  } catch (error) {
    // ... manejo de error ...
  }
});

// Endpoint: Crear bucket
app.post('/api/buckets', async (req, res) => {
  try {
    const { bucketName } = req.body;
    
    // 1. Validación básica del nombre
    const bucketNameRegex = /^(?=.{3,63}$)(?!.*\.\.)(?!-)[a-z0-9-]+(?<!-)$/;
    if (!bucketNameRegex.test(bucketName)) {
      return res.status(400).json({
        errorType: 'InvalidNameFormat',
        error: 'Formato de nombre inválido'
      });
    }

    // 2. Verificar existencia global
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      return res.status(409).json({ // 409 Conflict
        errorType: 'BucketAlreadyExists',
        error: 'El bucket ya existe en AWS'
      });
    } catch (headError) {
      if (headError.name !== 'NotFound') throw headError;
    }

    // 3. Crear bucket
    await s3Client.send(new CreateBucketCommand({
      Bucket: bucketName,
      CreateBucketConfiguration: process.env.AWS_REGION === 'us-east-1' 
        ? undefined
        : { LocationConstraint: process.env.AWS_REGION }
    }));

    await s3Client.send(new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false
      }
    }));

    // 5. Añadir política de acceso público
    const bucketPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicReadGetObject",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${bucketName}/*`
        }
      ]
    };

    await s3Client.send(new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(bucketPolicy)
    }));

    // 4. Configurar hosting estático
    await s3Client.send(new PutBucketWebsiteCommand({
      Bucket: bucketName,
      WebsiteConfiguration: {
        IndexDocument: { Suffix: "index.html" },
        ErrorDocument: { Key: "error.html" }
      }
    }));

    await s3Client.send(new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: [{
          AllowedHeaders: ["*"],
          AllowedMethods: ["GET"],
          AllowedOrigins: ["*"],
          ExposeHeaders: []
        }]
      }
    }));
    
    // 6. Subir archivos HTML por defecto
    const defaultHTML = {
      index: process.env.DEFAULT_INDEX_CONTENT || '<h1>Bienvenido a mi sitio</h1>',
      error: process.env.DEFAULT_ERROR_CONTENT || '<h1>Error 404</h1>'
    };
    
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: "index.html",
      Body: defaultHTML.index,
      ContentType: "text/html"
    }));
    
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: "error.html",
      Body: defaultHTML.error,
      ContentType: "text/html"
    }));

    res.status(201).json({
      success: true,
      message: `Bucket ${bucketName} creado con hosting estático`,
      endpoint: `http://${bucketName}.s3-website.${process.env.AWS_REGION}.amazonaws.com`
    });

  } catch (error) {
    console.error('Error:', error);

    // Obtener bucketName del body aunque falle la validación
    const bucketName = req.body?.bucketName || 'nombre_no_definido';

      // Rollback solo si existe
  if (bucketName && error.name !== 'BucketAlreadyExists') {
    try {
      await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    } catch (deleteError) {
      console.error('Error en rollback:', deleteError);
    }
  }

  res.status(500).json({
    errorType: error.name || 'UnknownError',
    error: 'Error al configurar el hosting estático'
  });
  }
});

app.delete('/api/buckets/:bucketName', async (req, res) => {
  try {
    const { bucketName } = req.params;

    // 1. Obtener región del bucket
    const { LocationConstraint: bucketRegion } = await s3Client.send(
      new GetBucketLocationCommand({ Bucket: bucketName })
    );

    // 2. Comparar regiones (AWS usa 'us-east-1' como valor por defecto)
    const expectedRegion = process.env.AWS_REGION === 'eu-south-2' 
      ? null 
      : process.env.AWS_REGION;

    // 3. Verificar si está vacío
    const { Contents } = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucketName })
    );

    if (Contents?.length > 0) {
      return res.status(400).json({
        errorType: 'BucketNotEmpty',
        error: 'El bucket contiene archivos'
      });
    }

    // 4. Eliminar
    await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    
    res.json({ success: true, message: `Bucket ${bucketName} eliminado` });

  } catch (error) {
    console.error('Error eliminando bucket:', error);
    
    let message = 'Error al eliminar el bucket';
    if (error.name === 'AccessDenied') message = 'Permisos insuficientes en AWS';
    if (error.name === 'NoSuchBucket') message = 'El bucket no existe';

    res.status(500).json({ 
      errorType: error.name || 'UnknownError',
      error: message 
    });
  }
});

// --- Nuevos Endpoints de Lightsail ---

// Endpoint: Listar instancias de Lightsail
app.get('/api/lightsail/instances', async (req, res) => {
  try {
    const command = new GetInstancesCommand({});
    const data = await lightsailClient.send(command);
    res.json({ instances: data.instances || [] });
  } catch (error) {
    console.error('Error listando instancias de Lightsail:', error);
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

// Endpoint: Obtener lista de bundles de Lightsail
app.get('/api/lightsail/bundles', async (req, res) => {
  try {
    const command = new GetBundlesCommand({ includeInactive: false });
    const data = await lightsailClient.send(command);
    res.json({ bundles: data.bundles || [] });
  } catch (error) {
    console.error('Error listando bundles de Lightsail:', error);
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

// Endpoint: Obtener lista de blueprints de Lightsail
app.get('/api/lightsail/blueprints', async (req, res) => {
  try {
    const command = new GetBlueprintsCommand({ includeInactive: false });
    const data = await lightsailClient.send(command);
    res.json({ blueprints: data.blueprints || [] });
  } catch (error) {
    console.error('Error listando blueprints de Lightsail:', error);
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});


// Endpoint: Crear instancia de Lightsail (Corregido manejo de error DoesNotExist)
app.post('/api/lightsail/instances', async (req, res) => {
    try {
      const { instanceName, blueprintId, bundleId, availabilityZone } = req.body;
  
      if (!instanceName || !blueprintId || !bundleId || !availabilityZone) {
        return res.status(400).json({ error: 'Faltan parámetros necesarios.' });
      }
  
      if (!availabilityZone.startsWith(process.env.LIGHTSAIL_REGION)) {
           return res.status(400).json({ error: `La zona de disponibilidad debe estar en la región ${process.env.LIGHTSAIL_REGION}` });
      }
  
      // --- 1. Verificar si el nombre de la instancia ya existe (MODIFICADO) ---
      try {
          const getInstanceCommand = new GetInstanceCommand({ instanceName: instanceName });
          await lightsailClient.send(getInstanceCommand);
          // Si la llamada send() no lanza un error, la instancia existe.
          console.warn(`BACKEND WARNING: Intento de crear instancia con nombre existente: '${instanceName}'`); // Log de intento de duplicado
          return res.status(409).json({ // 409 Conflict
              error: `Ya existe una instancia con el nombre '${instanceName}'. Por favor, elige otro nombre.`,
              errorType: 'InstanceAlreadyExists'
          });
      } catch (error) {
          // Si el error indica que la instancia NO existe (NotFoundException o DoesNotExist), continuamos.
          // Si es otro tipo de error, algo salió mal al verificar (permisos, red, etc.).
          if (error.name === 'NotFoundException' || error.name === 'DoesNotExist') { // <-- CAMBIO AQUÍ: Aceptar DoesNotExist
              console.log(`BACKEND LOG: Nombre de instancia '${instanceName}' disponible (${error.name}). Continuando...`); // Log de disponibilidad
          } else {
              console.error('BACKEND ERROR: Error inesperado al verificar existencia de instancia:', error);
              return res.status(500).json({ error: 'Error al verificar la existencia de la instancia.', errorType: error.name });
          }
      }
      // ---------------------------------------------------------
  
      // --- 2. Crear una clave SSH personalizada ---
      // ... (el resto del código para crear la clave e instancia, incluyendo los logs que añadimos antes) ...
      const keyPairName = `my-app-${uuidv4()}`;
      let privateKey = null;
      let keyPairData = null;
  
      try {
          const createKeyPairCommand = new CreateKeyPairCommand({ keyPairName: keyPairName });
          keyPairData = await lightsailClient.send(createKeyPairCommand);
  
          privateKey = keyPairData.privateKey || keyPairData.privateKeyBase64;
  
          console.log('BACKEND LOG: Respuesta completa de CreateKeyPairCommand:', keyPairData);
          console.log(`BACKEND LOG: Clave privada obtenida (presente: ${!!privateKey})`);
  
          if (!privateKey) {
               console.error('BACKEND ERROR: La respuesta de CreateKeyPairCommand no contiene la clave privada esperada.');
               return res.status(500).json({ error: 'No se pudo obtener la clave privada de la clave SSH creada.', errorType: 'PrivateKeyMissingInResponse' });
          }
  
      } catch (error) {
          console.error('BACKEND ERROR: Error al crear la clave SSH:', error);
          return res.status(500).json({ error: 'Error al crear la clave SSH.', errorType: error.name });
      }
  
      // --- 3. Crear la instancia asociando la clave ---
      let instanceCreationData = null;
      try {
          const createInstanceCommand = new CreateInstancesCommand({
              instanceNames: [instanceName],
              blueprintId: blueprintId,
              bundleId: bundleId,
              availabilityZone: availabilityZone,
              keyPairName: keyPairName,
          });
  
          instanceCreationData = await lightsailClient.send(createInstanceCommand);
  
          console.log('BACKEND LOG: Respuesta completa de CreateInstancesCommand:', instanceCreationData);
  
          if (!instanceCreationData || !Array.isArray(instanceCreationData.operations)) {
               console.warn('BACKEND WARNING: La respuesta de CreateInstancesCommand no contiene el array operations esperado.', instanceCreationData);
          }
  
      } catch (error) {
          console.error('BACKEND ERROR: Error al crear la instancia:', error);
          let userMessage = 'Error al iniciar la creación de la instancia.';
           if (error.name === 'InvalidInputException') {
               userMessage = 'Error en los datos proporcionados (blueprint, bundle, zone inválidos?).';
           } else if (error.name === 'ServiceException') {
               userMessage = `Error del servicio Lightsail: ${error.message}`;
           } else {
               userMessage = `Error inesperado: ${error.message}`;
           }
          return res.status(500).json({ error: userMessage, errorType: error.name });
      }
      // ---------------------------------------------------------
  
      // --- 4. Retornar la respuesta incluyendo la clave privada ---
      console.log('BACKEND LOG: Enviando respuesta final exitosa al frontend.');
  
      const finalResponse = {
          success: true,
          message: 'Instancia de Lightsail creada con clave SSH personalizada.',
          instanceCreationResponse: instanceCreationData,
          keyPair: {
              keyPairName: keyPairName,
              privateKey: privateKey
          }
      };
  
      console.log('BACKEND LOG: Estructura de respuesta final:', JSON.stringify(finalResponse, null, 2));
  
      res.status(201).json(finalResponse);
    } catch (error) {
      console.error('BACKEND ERROR: Error general en el endpoint de creación:', error);
      res.status(500).json({ error: 'Error en la solicitud.', errorType: error.name });
    }
  });

  app.get('/api/buckets/:bucketName/website-test', async (req, res) => {
    try {
      const { bucketName } = req.params;
      const testUrl = getWebsiteEndpoint(bucketName, process.env.AWS_REGION);
      const response = await fetch(testUrl);
      
      res.json({
        status: response.status,
        working: response.ok,
        url: testUrl
      });
    } catch (error) {
      res.status(500).json({ error: "Error testing website" });
    }
  });

app.listen(port, () => {
  console.log(`🚀 Backend listo en http://localhost:${port}`);
});