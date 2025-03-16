// Fullstack_Part8/index.js
const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@apollo/server/express4");
const {
  ApolloServerPluginDrainHttpServer,
} = require("@apollo/server/plugin/drainHttpServer");
const { makeExecutableSchema } = require("@graphql-tools/schema");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const { useServer } = require("graphql-ws/lib/use/ws");
const { PubSub } = require("graphql-subscriptions");
const { GraphQLError } = require("graphql");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Book = require("./models/book");
const Author = require("./models/author");
const User = require("./models/user");
require("dotenv").config();
// Create pubsub instance
const pubsub = new PubSub();
const MONGODB_URI = process.env.MONGODB_URI;
console.log("connecting to", MONGODB_URI);
const JWT_SECRET = process.env.JWT_SECRET || "NEED_A_SECRET_KEY";
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("connected to MongoDB"))
  .catch((error) => console.log("error connecting to MongoDB:", error.message));
const typeDefs = `
  type Book {
    title: String!
    published: Int!
    author: Author!
    genres: [String!]!
    id: ID!
  }
  type Author {
    name: String!
    born: Int
    bookCount: Int!
    id: ID!
  }
  type User {
    username: String!
    favoriteGenre: String!
    id: ID!
  }
  type Token {
    value: String!
  }
  type Query {
    bookCount: Int!
    authorCount: Int!
    allBooks(author: String, genre: String): [Book!]!
    allAuthors: [Author!]!
    me: User
  }
  type Mutation {
    addBook(
      title: String!
      author: String!
      published: Int!
      genres: [String!]!
    ): Book!
    editAuthor(name: String!, setBornTo: Int!): Author
    createUser(
      username: String!
      favoriteGenre: String!
    ): User
    login(
      username: String!
      password: String!
    ): Token
  }
  type Subscription {
    bookAdded: Book!
  }
`;
const resolvers = {
  Query: {
    bookCount: async () => Book.collection.countDocuments(),
    authorCount: async () => Author.collection.countDocuments(),
    allBooks: async (root, args) => {
      // Create a filter object based on the arguments
      let filter = {};
      // Filter by genre if specified
      if (args.genre) {
        filter.genres = { $in: [args.genre] };
      }
      // Filter by author name if specified
      if (args.author) {
        const author = await Author.findOne({ name: args.author });
        if (author) {
          filter.author = author._id;
        } else {
          return []; // No books if author doesn't exist
        }
      }
      // Find books with the constructed filter and populate author
      return Book.find(filter).populate("author");
    },
    allAuthors: async () => {
      const authors = await Author.aggregate([
        {
          $lookup: {
            from: "books",
            localField: "_id",
            foreignField: "author",
            as: "books",
          },
        },
        {
          $project: {
            name: 1,
            born: 1,
            bookCount: { $size: "$books" },
          },
        },
      ]);
      // Map _id to id for GraphQL
      return authors.map((author) => ({
        ...author,
        id: author._id.toString(),
      }));
    },
    me: (root, args, context) => {
      return context.currentUser;
    },
  },
  Author: {
    // We only use this resolver for authors that don't have bookCount from aggregation
    bookCount: async (root) => {
      // If bookCount is already calculated (from aggregation), use that
      if (root.bookCount !== undefined) {
        return root.bookCount;
      }
      // Otherwise count manually (fallback case)
      return Book.countDocuments({ author: root._id });
    },
  },
  Mutation: {
    addBook: async (root, args, context) => {
      const { currentUser } = context;
      if (!currentUser) {
        throw new GraphQLError("Not authenticated", {
          extensions: {
            code: "UNAUTHENTICATED",
          },
        });
      }
      // Find the author or create a new one
      let author = await Author.findOne({ name: args.author });
      if (!author) {
        author = new Author({ name: args.author });
        try {
          await author.save();
        } catch (error) {
          throw new GraphQLError("Saving author failed", {
            extensions: {
              code: "BAD_USER_INPUT",
              invalidArgs: args.author,
              error,
            },
          });
        }
      }
      // Create and save the new book
      const book = new Book({
        title: args.title,
        published: args.published,
        author: author._id,
        genres: args.genres,
      });
      try {
        await book.save();
      } catch (error) {
        throw new GraphQLError("Saving book failed", {
          extensions: {
            code: "BAD_USER_INPUT",
            invalidArgs: { title: args.title, published: args.published },
            error,
          },
        });
      }
      // Populate the author field for the response
      const populatedBook = await Book.findById(book._id).populate("author");
      // Publish the new book to subscribers
      pubsub.publish("BOOK_ADDED", { bookAdded: populatedBook });
      return populatedBook;
    },
    editAuthor: async (root, args, { currentUser }) => {
      if (!currentUser) {
        throw new GraphQLError("Not authenticated", {
          extensions: {
            code: "UNAUTHENTICATED",
          },
        });
      }
      const author = await Author.findOne({ name: args.name });
      if (!author) {
        return null;
      }
      author.born = args.setBornTo;
      try {
        await author.save();
      } catch (error) {
        throw new GraphQLError("Updating author failed", {
          extensions: {
            code: "BAD_USER_INPUT",
            invalidArgs: args.setBornTo,
            error,
          },
        });
      }
      return author;
    },
    createUser: async (root, args) => {
      const user = new User({
        username: args.username,
        favoriteGenre: args.favoriteGenre,
      });
      try {
        await user.save();
      } catch (error) {
        throw new GraphQLError("Creating user failed", {
          extensions: {
            code: "BAD_USER_INPUT",
            invalidArgs: args.username,
            error,
          },
        });
      }
      return user;
    },
    login: async (root, args) => {
      const user = await User.findOne({ username: args.username });
      if (!user || args.password !== "secret") {
        throw new GraphQLError("Wrong credentials", {
          extensions: {
            code: "BAD_USER_INPUT",
          },
        });
      }
      const userForToken = {
        username: user.username,
        id: user._id,
      };
      return { value: jwt.sign(userForToken, JWT_SECRET) };
    },
  },
  Subscription: {
    bookAdded: {
      subscribe: () => pubsub.asyncIterator(["BOOK_ADDED"]),
    },
  },
};
// Set up the server with subscriptions support
const start = async () => {
  const app = express();
  const httpServer = http.createServer(app);
  const schema = makeExecutableSchema({ typeDefs, resolvers });

  // Setup logging middleware first
  app.use((req, res, next) => {
    console.log(`Incoming request: ${req.method} ${req.path}`);
    next();
  });

  // Apply CORS middleware
  app.use(cors());

  // WebSocket server setup for subscriptions
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });
  
  const serverCleanup = useServer(
    {
      schema,
      // Important: Add context for the WebSocket connection
      context: async (ctx) => {
        // You can add authentication here if needed
        return { pubsub };
      },
      // Add error handlers
      onConnect: async (ctx) => {
        console.log("Client connected to WebSocket");
        return true;
      },
      onDisconnect: async (ctx, code, reason) => {
        console.log("Client disconnected from WebSocket");
      },
      onError: (ctx, message, errors) => {
        console.error("WebSocket error:", message, errors);
      },
    },
    wsServer
  );
  
  // Initialize Apollo Server
  const server = new ApolloServer({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          console.log("Server starting up");
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
    ],
  });
  
  await server.start();
  
  // Set up the GraphQL endpoint first
  app.use(
    "/graphql",
    express.json(),
    expressMiddleware(server, {
      context: async ({ req }) => {
        const auth = req ? req.headers.authorization : null;
        if (auth && auth.toLowerCase().startsWith("bearer ")) {
          try {
            const decodedToken = jwt.verify(auth.substring(7), JWT_SECRET);
            const currentUser = await User.findById(decodedToken.id);
            return { currentUser, pubsub };
          } catch (error) {
            console.error("Token verification failed:", error.message);
            return { pubsub };
          }
        }
        return { pubsub };
      },
    })
  );
  
  // Simple response for the root path - NO REDIRECT
  app.get("/", (req, res) => {
    res.send('GraphQL API is running at <a href="/graphql">/graphql</a>');
  });

  // Handle POST to root differently to avoid redirect loops
  app.post("/", express.json(), (req, res) => {
    console.log("POST request to root - should go to /graphql instead");
    
    // Forward the request to the GraphQL handler
    expressMiddleware(server, {
      context: async ({ req }) => {
        const auth = req ? req.headers.authorization : null;
        if (auth && auth.toLowerCase().startsWith("bearer ")) {
          try {
            const decodedToken = jwt.verify(auth.substring(7), JWT_SECRET);
            const currentUser = await User.findById(decodedToken.id);
            return { currentUser, pubsub };
          } catch (error) {
            return { pubsub };
          }
        }
        return { pubsub };
      },
    })(req, res);
  });
  
  const PORT = 4000;
  httpServer.listen(PORT, () => {
    console.log(`Server ready at http://localhost:${PORT}/graphql`);
    console.log(
      `Subscription endpoint ready at ws://localhost:${PORT}/graphql`
    );
  });
};
start();