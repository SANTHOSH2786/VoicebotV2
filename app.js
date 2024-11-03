const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const CONFIG_FILE_PATH = path.join(__dirname, 'config.js');
let OPENAI_API_KEY;

try {
    OPENAI_API_KEY = require(CONFIG_FILE_PATH).OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
        throw new Error("OpenAI API key is missing or not configured in config.js.");
    }
} catch (error) {
    console.error("Error loading OpenAI API key:", error.message);
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const upload = multer({ dest: 'uploads/' });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/chat', upload.single('file'), async (req, res) => {
    const query = req.body.query;
    let fileContent = '';

    if (req.file) {
        const filePath = req.file.path;
        const fileType = req.file.mimetype;

        try {
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
            } else if (fileType === 'text/plain') {
                fileContent = fs.readFileSync(filePath, 'utf8');
            } else if (fileType === 'application/json') {
                fileContent = JSON.stringify(JSON.parse(fs.readFileSync(filePath, 'utf8')));
            } else if (fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.readFile(filePath);
                const worksheet = workbook.worksheets[0];
                const rows = [];
                worksheet.eachRow((row) => {
                    rows.push(row.values);
                });
                fileContent = JSON.stringify(rows);
            } else {
                fs.unlink(filePath, (err) => {
                    if (err) console.error("Error deleting file:", err);
                });
                return res.status(400).send('Unsupported file type.');
            }

            fs.unlink(filePath, (err) => {
                if (err) console.error("Error deleting file:", err);
            });

            await processQueryAndRespond(query, fileContent, res);
        } catch (error) {
            console.error("Error processing file:", error);
            res.status(500).send('Error processing file');
        }
    } else {
        await processQueryAndRespond(query, null, res);
    }
});

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

        if (response.data.choices && response.data.choices.length > 0) {
            res.json({ response: response.data.choices[0].message.content });
        } else {
            res.json({ response: 'No valid response from the AI.' });
        }
    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ message: 'Error processing request', details: error.message });
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
