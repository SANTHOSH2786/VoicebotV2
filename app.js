const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const winston = require('winston');

// Load the OpenAI API key from the config file
const CONFIG_FILE_PATH = path.join(__dirname, 'config.js');
let OPENAI_API_KEY;

try {
    OPENAI_API_KEY = require(CONFIG_FILE_PATH).OPENAI_API_KEY;
    if (!OPENAI_API_KEY || OPENAI_API_KEY === 'OpenAPI-Keyaddedhere') {
        throw new Error("OpenAI API key is missing or not configured in config.js.");
    }
} catch (error) {
    console.error("Error loading OpenAI API key:", error.message);
    process.exit(1); // Exit if API key is missing or invalid
}

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Set up logging with Winston
const logFilePath = path.join(logsDir, `app_${new Date().toISOString().slice(0, 10)}.log`);
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: logFilePath, level: 'info' }),
        new winston.transports.Console({ level: 'info' })  // Optional: log to console as well
    ]
});

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Set up file upload using multer
const upload = multer({ dest: 'uploads/' });

// Serve the HTML file at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to handle chat requests and file uploads
app.post('/api/chat', upload.single('file'), async (req, res) => {
    const query = req.body.query;
    let fileContent = '';

    logger.info(`Received Query: ${query}`);

    if (req.file) {
        const filePath = req.file.path;
        const fileType = req.file.mimetype;

        logger.info(`Received File: ${req.file.originalname}, Type: ${fileType}`);

        try {
            // Process CSV files
            if (fileType === 'text/csv') {
                const csvParser = require('csv-parser');
                fileContent = await new Promise((resolve, reject) => {
                    const dataArray = [];
                    fs.createReadStream(filePath)
                        .pipe(csvParser())
                        .on('data', (data) => dataArray.push(data))
                        .on('end', () => resolve(JSON.stringify(dataArray)))
                        .on('error', (error) => reject(error));
                });
            }
            // Process plain text files
            else if (fileType === 'text/plain') {
                fileContent = fs.readFileSync(filePath, 'utf8');
            }
            // Process JSON files
            else if (fileType === 'application/json') {
                const rawData = fs.readFileSync(filePath, 'utf8');
                fileContent = JSON.stringify(JSON.parse(rawData));
            }
            // Process Excel files (.xlsx)
            else if (fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.readFile(filePath);
                const worksheet = workbook.worksheets[0];  // Read the first sheet
                const rows = [];

                worksheet.eachRow((row, rowNumber) => {
                    rows.push(row.values);
                });

                fileContent = JSON.stringify(rows);
            }
            // Unsupported file types
            else {
                fs.unlink(filePath, (err) => {
                    if (err) console.error("Error deleting file:", err);
                });
                logger.warn('Unsupported file type uploaded');
                return res.status(400).send('Unsupported file type. Please upload a CSV, TXT, JSON, or XLSX file.');
            }

            // Delete the uploaded file after processing
            fs.unlink(filePath, (err) => {
                if (err) console.error("Error deleting file:", err);
            });

            // Process query with file content
            await processQueryAndRespond(query, fileContent, res);
        } catch (error) {
            logger.error("Error processing file:", error);
            res.status(500).send('Error processing file');
        }
    } else {
        // Process the query without a file
        await processQueryAndRespond(query, null, res);
    }
});

// Function to send query to OpenAI and respond to client
async function processQueryAndRespond(query, fileContent, res) {
    try {
        const messages = [
            { role: 'user', content: query || 'Please summarize the file content.' }
        ];
        if (fileContent) {
            messages.push({ role: 'user', content: `File content: ${fileContent}` });
        }

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-3.5-turbo',
            messages: messages
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const aiResponse = response.data.choices[0]?.message?.content || 'No response from AI';
        logger.info(`AI Response: ${aiResponse}`);

        res.json({ response: aiResponse });
    } catch (error) {
        if (error.response) {
            logger.error("OpenAI API Error:", error.response.data);
            res.status(500).json({
                message: 'Error fetching response from OpenAI',
                details: error.response.data,
            });
        } else if (error.request) {
            logger.error("Network Error: No response received from OpenAI");
            res.status(500).json({ message: 'Network error: No response received from OpenAI' });
        } else {
            logger.error("Request Error:", error.message);
            res.status(500).json({ message: 'Error processing request', details: error.message });
        }
    }
}

app.listen(PORT, () => {
    logger.info(`Server is running on http://localhost:${PORT}`);
});
