import express from 'express';
import { sql } from '@vercel/postgres';
import { Client, LogLevel } from '@notionhq/client';
import { NotionAPI } from 'notion-client';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const urlencodedParser = bodyParser.urlencoded({ extended: false });
app.use(express.json());
app.use(cors());

// Configuración del cliente de Notion oficial
const notion = new Client({
    auth: process.env.NOTION_TOKEN,
    logLevel: LogLevel.DEBUG
});

// Configuración del NotionAPI de react-notion-x
const notionX = new NotionAPI();

app.use(express.static('public'));

app.get('/', function (req, res) {
    res.sendFile(path.join(process.cwd(), 'components', 'home.htm'));
});

// Endpoint para obtener información de la cohorte
app.post('/api/cohort-info', async (req, res) => {
    try {
        const { cohortId } = req.body;

        if (!cohortId) {
            return res.status(400).json({ error: 'Se requiere el ID de la cohorte' });
        }

        const response = await notion.databases.query({
            database_id: process.env.NOTION_DATABASE_ID || '',
            filter: {
                or: [
                    {
                        property: '4Geeks ID',
                        rich_text: {
                            equals: `${cohortId}`,
                        },
                    },
                ],
            },
        });

        if (!response.results || response.results.length === 0) {
            return res.status(404).json({ error: 'Cohorte no encontrada' });
        }

        res.status(200).json(response.results[0]);
    } catch (error) {
        console.error('Error obteniendo información de Notion:', error);
        res.status(500).json({ error: 'Error al obtener información de la cohorte' });
    }
});

// endpoint para obtener información de un estudiante específico
app.post('/api/student-info', async (req, res) => {
    try {
        const { studentId } = req.body;

        if (!studentId) {
            return res.status(400).json({ error: 'Se requiere el ID del estudiante' });
        }

        const studentResponse = await notion.pages.retrieve({
            page_id: studentId
        });

        if (!studentResponse) {
            return res.status(404).json({ error: 'Estudiante no encontrado' });
        }

        res.status(200).json(studentResponse);
    } catch (error) {
        console.error('Error obteniendo información del estudiante:', error);
        res.status(500).json({ error: 'Error al obtener información del estudiante' });
    }
});

// Endpoint para obtener el contenido de una página de Notion usando notion-client (react-notion-x)
app.post('/api/notion-page', async (req, res) => {
    try {
        const { pageId } = req.body;

        if (!pageId) {
            return res.status(400).json({ error: 'Se requiere el ID de la página de Notion' });
        }

        // Usar NotionAPI de react-notion-x para obtener la página y sus bloques
        const recordMap = await notionX.getPage(pageId);

        if (!recordMap) {
            return res.status(404).json({ error: 'Página no encontrada' });
        }

        res.status(200).json({
            recordMap
        });
    } catch (error) {
        console.error('Error obteniendo contenido de la página de Notion:', error);
        res.status(500).json({ error: 'Error al obtener el contenido de la página' });
    }
});

app.listen(5000, () => console.log('Server ready on port 5000.'));

export { app };
