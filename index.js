const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const app = express();
const axios = require('axios');
const cors = require('cors');
const PORT = 3001;

// Load environment variables from .env file
dotenv.config();

app.use(cors());
app.use(bodyParser.json());

// Connect to MongoDB using the URL from the .env file
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));

// Define the User model
const UserSchema = new mongoose.Schema({
    clerkUserId: { type: String, required: true, unique: true },
    firstName: String,
    lastName: String,
    email: String,
});
const User = mongoose.model('User', UserSchema);

// Article schema (in your backend code)
const articleSchema = new mongoose.Schema({
    title: { type: String, required: true, unique: true },
    description: String,
    url: String,
    publishedAt: Date,
    source: {
        id: String,
        name: String,
        country: String
    },
    category: String,
    urlToImage: String,
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] // Track user IDs who liked the article
});

const Article = mongoose.model('Article', articleSchema);


// Helper function to fetch and save articles
const fetchAndSaveArticles = async (category) => {
    const apiKey = process.env.NEWS_API_KEY;
    const apiUrl = `https://newsapi.org/v2/top-headlines?language=en&category=${encodeURIComponent(category)}&apiKey=${apiKey}`;

    try {
        const response = await axios.get(apiUrl, {
            headers: { 'X-Api-Key': apiKey }
        });

        const articles = response.data.articles;

        for (const article of articles) {
            // Check if the article already exists in the database by title
            const existingArticle = await Article.findOne({ title: article.title });

            if (!existingArticle) {
                // Save new article to the database
                const newArticle = new Article({
                    title: article.title,
                    description: article.description,
                    url: article.url,
                    publishedAt: article.publishedAt,
                    source: article.source,
                    category: category,
                    urlToImage: article.urlToImage || null, // Save urlToImage if available
                });

                await newArticle.save();
                console.log('New article saved:', article.title);
            } else {
                console.log('Article already exists:', article.title);
            }
        }

        return { message: `Headlines for category ${category} fetched and saved to the database (if new).` };
    } catch (error) {
        console.error(`Error fetching ${category} headlines:`, error.message);
        throw new Error(`An error occurred while fetching ${category} headlines.`);
    }
};

// Array of categories to fetch from NewsAPI
const categories = ['general', 'sports', 'technology', 'health', 'business'];

// Fetch and save articles for each category at server startup
const fetchAllCategories = async () => {
    for (const category of categories) {
        try {
            const result = await fetchAndSaveArticles(category);
            console.log(result.message);
        } catch (error) {
            console.error(`Error fetching ${category} articles:`, error.message);
        }
    }
};

// Fetch all categories once at server startup
fetchAllCategories();
// Middleware to parse JSON payloads
app.use(bodyParser.json());

// Webhook endpoint for user creation and deletion
app.post('/api/webhooks', async (req, res) => {
    try {
        console.log('Received webhook payload:', req.body);

        if (req.body.type === 'user.created') {
            const userData = req.body.data;
            const clerkUserId = userData.id;
            const firstName = userData.first_name;
            const lastName = userData.last_name;
            const primaryEmail = userData.email_addresses[0] ? userData.email_addresses[0].email : null;

            if (!clerkUserId) {
                return res.status(400).json({ success: false, message: 'clerkUserId is required' });
            }

            // Create and save the user to MongoDB
            const user = new User({
                clerkUserId,
                firstName,
                lastName,
                email: primaryEmail,
            });

            await user.save();
            console.log('User created:', user);

            return res.status(200).json({
                success: true,
                message: 'User created successfully',
            });
        }

        if (req.body.type === 'user.deleted') {
            const deletedUserId = req.body.data.id;
            await User.findOneAndDelete({ clerkUserId: deletedUserId });
            console.log(`User deleted: ${deletedUserId}`);
            return res.status(200).json({
                success: true,
                message: 'User deleted successfully',
            });
        }

        return res.status(400).json({ success: false, message: 'Unknown event type' });

    } catch (err) {
        console.error('Error processing webhook:', err);
        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

// Like an article
app.post('/articles/:id/like', async (req, res) => {
    const articleId = req.params.id;
    const userId = req.body.userId; // Expecting userId to be sent in the request body

    try {
        const article = await Article.findById(articleId);
        if (!article) return res.status(404).json({ message: 'Article not found' });
        console.log(article.likes.length, "before")
        if (!article.likes.includes(userId)) {
            article.likes.push(userId);
            await article.save();
        }
        console.log(article.likes.length, "likes")
        res.status(200).json({ likesCount: article.likes.length });
    } catch (error) {
        console.error('Error liking article:', error.message);
        res.status(500).json({ message: 'Failed to like article' });
    }
});

// Unlike an article
app.post('/articles/:id/unlike', async (req, res) => {
    const articleId = req.params.id;
    const userId = req.body.userId;

    try {
        const article = await Article.findById(articleId);
        if (!article) return res.status(404).json({ message: 'Article not found' });

        article.likes = article.likes.filter((id) => id.toString() !== userId);
        await article.save();

        res.status(200).json({ likesCount: article.likes.length });
    } catch (error) {
        console.error('Error unliking article:', error.message);
        res.status(500).json({ message: 'Failed to unlike article' });
    }
});

// Route for enhanced search functionality
app.get('/search', async (req, res) => {
    const { title, country, category, date } = req.query;
    const searchCriteria = {};

    if (title) {
        searchCriteria.title = { $regex: title, $options: 'i' };
    }
    if (country) {
        searchCriteria['source.country'] = { $regex: country, $options: 'i' };
    }
    if (category) {
        searchCriteria.category = { $regex: category, $options: 'i' };
    }
    if (date) {
        // Filter for a specific date or date range (optional time)
        const dateObj = new Date(date);
        searchCriteria.publishedAt = {
            $gte: new Date(dateObj.setHours(0, 0, 0, 0)),
            $lt: new Date(dateObj.setHours(23, 59, 59, 999))
        };
    }

    try {
        const searchResults = await Article.find(searchCriteria);

        if (searchResults.length === 0) {
            return res.status(404).json({ message: 'No articles found matching your query' });
        }

        res.status(200).json(searchResults);
    } catch (error) {
        console.error('Error searching articles:', error.message);
        res.status(500).json({ message: 'An error occurred while searching for articles' });
    }
});

// Get headlines from the database
app.get('/headlines', async (req, res) => {
    try {
        const articles = await Article.find({ category: 'general' });

        // Ensure `likeCount` defaults to 0 if `likedBy` is undefined
        const response = articles.map(article => ({
            ...article.toObject(),
            likeCount: article.likes ? article.likes.length : 0
        }));

        res.status(200).json(response);
    } catch (err) {
        console.error('Error fetching headlines:', err);
        res.status(500).json({ error: 'Failed to fetch headlines' });
    }
});


// Route for sports headlines
app.get('/sports', async (req, res) => {
    try {
        // Fetch articles where the category is 'sports'
        const sportsArticles = await Article.find({ category: 'sports' });
        res.status(200).json(sportsArticles);
    } catch (err) {
        console.error('Error fetching sports articles:', err);
        res.status(500).json({ error: 'Failed to fetch sports articles' });
    }
});


// Route for education headlines
app.get('/health', async (req, res) => {
    try {
        // Fetch articles where the category is 'sports'
        const sportsArticles = await Article.find({ category: 'health' });
        res.status(200).json(sportsArticles);
    } catch (err) {
        console.error('Error fetching sports articles:', err);
        res.status(500).json({ error: 'Failed to fetch sports articles' });
    }
});

// Route for political headlines
app.get('/business', async (req, res) => {
    try {
        // Fetch articles where the category is 'sports'
        const sportsArticles = await Article.find({ category: 'business' });
        res.status(200).json(sportsArticles);
    } catch (err) {
        console.error('Error fetching sports articles:', err);
        res.status(500).json({ error: 'Failed to fetch sports articles' });
    }
});


// Route for science and technology headlines
app.get('/technology', async (req, res) => {
    try {
        // Fetch articles where the category is 'sports'
        const sportsArticles = await Article.find({ category: 'technology' });
        res.status(200).json(sportsArticles);
    } catch (err) {
        console.error('Error fetching sports articles:', err);
        res.status(500).json({ error: 'Failed to fetch sports articles' });
    }
});

// Category-specific routes for different headlines
app.get('/categories/:category', async (req, res) => {
    const { category } = req.params;
    try {
        const articles = await Article.find({ category });
        res.status(200).json(articles);
    } catch (err) {
        console.error(`Error fetching ${category} articles:`, err);
        res.status(500).json({ error: `Failed to fetch ${category} articles` });
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
