const express = require('express');
const cors = require('cors');
const admin = require("firebase-admin");
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { default: Stripe } = require('stripe');

const app = express();
const port = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);


const decodedKey = Buffer.from(process.env.FB_Service_Key, 'base64').toString('utf8');
const serviceAccount = JSON.parse(decodedKey);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


// Middleware
app.use(cors({
     origin: [
    'https://profast-22ef5.web.app/',
  ],
    
    credentials: true
}));
// app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.m3ap4zb.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// Run function with routes
async function run() {
    try {
        await client.connect();
        const db = client.db('Profast');
        const parcelCollection = db.collection('parcels_info');
        const paymentsCollection = db.collection('payments');
        const usersCollection = db.collection('users');
        const ridersCollection = db.collection('riders');
        const trackingsCollection = db.collection("trackings");

        // custom middlewares
        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({ message: 'unauthorized access' })
            }
            const token = authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).send({ message: 'unauthorized access' })
            }

            // verify the token
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            }
            catch (error) {
                return res.status(403).send({ message: 'forbidden access' })
            }
        }

        const varifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email }
            const user = await usersCollection.findOne(query);
            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }

        //  user related apis

        app.get("/users/search", verifyFBToken, async (req, res) => {
            const emailQuery = req.query.email;
            if (!emailQuery) {
                return res.status(400).send({ message: "Missing email query" });
            }

            const regex = new RegExp(emailQuery, "i"); // case-insensitive partial match

            try {
                const users = await usersCollection
                    .find({ email: { $regex: regex } })
                    // .project({ email: 1, createdAt: 1, role: 1 })
                    .limit(10)
                    .toArray();
                res.send(users);
            } catch (error) {
                console.error("Error searching users", error);
                res.status(500).send({ message: "Error searching users" });
            }
        });

        // GET: Get user role by email
        app.get('/users/:email/role', async (req, res) => {
            try {
                const email = req.params.email;

                if (!email) {
                    return res.status(400).send({ message: 'Email is required' });
                }

                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).send({ message: 'User not found' });
                }

                res.send({ role: user.role || 'user' });
            } catch (error) {
                console.error('Error getting user role:', error);
                res.status(500).send({ message: 'Failed to get role' });
            }
        });


        app.post('/users', async (req, res) => {
            const email = req.body.email;
            const userExists = await usersCollection.findOne({ email })
            if (userExists) {
                // update last log in
                return res.status(200).send({ message: 'User already exists', inserted: false });
            }
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        })

        app.patch("/users/:id/role", async (req, res) => {
            const { id } = req.params;
            const { role } = req.body;

            if (!["admin", "user"].includes(role)) {
                return res.status(400).send({ message: "Invalid role" });
            }

            try {
                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { role } }
                );
                res.send({ message: `User role updated to ${role}`, result });
            } catch (error) {
                console.error("Error updating user role", error);
                res.status(500).send({ message: "Failed to update user role" });
            }
        });

        // Rider related apis
        app.post('/riders', async (req, res) => {
            try {
                const rider = req.body;
                console.log("Received rider:", rider);
                if (
                    !rider.name ||
                    !rider.age ||
                    !rider.email ||
                    !rider.nid ||
                    !rider.contact ||
                    !rider.district ||
                    !rider.region ||
                    !rider.warehouse
                ) {
                    return res.status(400).send({ message: 'Missing required rider fields' });
                }

                rider.status = 'Pending';
                rider.createdAt = new Date();
                const result = await ridersCollection.insertOne(rider)
                console.log('Insert result:', result);
                res.status(201).send({
                    message: 'Rider added successfully',
                    insertedId: result.insertedId,
                });
            } catch (error) {
                console.error('Rider insert error:', error);
                res.status(500).send({ message: 'Failed to add rider', error: error.message });
            }
        });

        app.get('/riders', verifyFBToken, async (req, res) => {
            try {
                const riders = await ridersCollection.find().toArray();
                res.send(riders);
            } catch (error) {
                console.error('Failed to fetch riders:', error);
                res.status(500).send({ message: 'Internal server error' });
            }
        });

        app.patch("/riders/:id/status", async (req, res) => {
            const { id } = req.params;
            const { status, email } = req.body;
            const query = { _id: new ObjectId(id) }
            const updateDoc = {
                $set:
                {
                    status
                }
            }

            try {
                const result = await ridersCollection.updateOne(
                    query, updateDoc

                );

                // update user role for accepting rider
                if (status === 'active') {
                    const userQuery = { email };
                    const userUpdateDoc = {
                        $set: {
                            role: 'rider'
                        }
                    };
                    const roleResult = await usersCollection.updateOne(userQuery, userUpdateDoc)
                    console.log(roleResult.modifiedCount)
                }

                res.send(result);
            } catch (err) {
                res.status(500).send({ message: "Failed to update rider status" });
            }
        });


        app.delete('/riders/:id', async (req, res) => {
            const id = req.params.id;
            const result = await ridersCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        // Active rider

        app.get('/riders/active', verifyFBToken,varifyAdmin, async (req, res) => {
            try {
                const activeRiders = await ridersCollection.find({

                    status: "active"
                }).toArray();

                res.send(activeRiders);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to fetch active riders" });
            }
        });

        app.patch("/parcels/:id/status", async (req, res) => {
            const parcelId = req.params.id;
            const { status } = req.body;
            const updatedDoc = {
                delivery_status: status
            }

            if (status === 'in_transit') {
                updatedDoc.picked_at = new Date().toISOString()
            }
            else if (status === 'delivered') {
                updatedDoc.delivered_at = new Date().toISOString()
            }

            try {
                const result = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: updatedDoc
                    }
                );
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to update status" });
            }
        });
        // cashout api
        app.patch("/parcels/:id/cashout", async (req, res) => {
            const id = req.params.id;
            const result = await parcelCollection.updateOne(
                { _id: new ObjectId(id) },
                {
                    $set: {
                        cashout_status: "cashed_out",
                        cashed_out_at: new Date()
                    }
                }
            );
            res.send(result);
        });

        app.get("/riders/available", verifyFBToken, async (req, res) => {
            const { district } = req.query;

            try {
                const riders = await ridersCollection
                    .find({
                        district,
                        // status: { $in: ["approved", "active"] },
                        // work_status: "available",
                    })
                    .toArray();

                res.send(riders);
            } catch (err) {
                res.status(500).send({ message: "Failed to load riders" });
            }
        });

        // GET: Load completed parcel deliveries for a rider
        app.get('/rider/completed-parcels', async (req, res) => {
            try {
                const email = req.query.email;

                if (!email) {
                    return res.status(400).send({ message: 'Rider email is required' });
                }

                const query = {
                    assigned_rider_email: email,
                    delivery_status: {
                        $in: ['delivered', 'service_center_delivered']
                    },
                };

                const options = {
                    sort: { creation_date: -1 }, // Latest first
                };

                const completedParcels = await parcelCollection.find(query, options).toArray();

                res.send(completedParcels);

            } catch (error) {
                console.error('Error loading completed parcels:', error);
                res.status(500).send({ message: 'Failed to load completed deliveries' });
            }
        });



        // Get All Parcels or Filtered by Email
        app.get('/parcels', verifyFBToken, async (req, res) => {
            try {
                const { email, payment_status, delivery_status } = req.query;
                let query = {}
                if (email) {
                    query = { created_by: email }
                }

                if (payment_status) {
                    query.payment_status = payment_status
                }

                if (delivery_status) {
                    query.delivery_status = delivery_status
                }

                const options = {
                    sort: { createdAt: -1 }, // Newest first
                };

                console.log('parcel query', req.query, query)

                const parcels = await parcelCollection.find(query, options).toArray();
                res.send(parcels);
            } catch (error) {
                console.error('Error fetching parcels:', error);
                res.status(500).send({ message: 'Failed to get parcels' });
            }
        });

        app.patch("/parcels/:id/assign", async (req, res) => {
            const parcelId = req.params.id;
            const { riderId, riderName, riderEmail, riderContact } = req.body;

            try {
                // Update parcel
                await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            delivery_status: "rider_assigned",
                            assigned_rider_id: riderId,
                            assigned_rider_name: riderName,
                            assigned_rider_email: riderEmail,
                            assigned_rider_contact: riderContact
                        },
                    }
                );

                // Update rider
                await ridersCollection.updateOne(
                    { _id: new ObjectId(riderId) },
                    {
                        $set: {
                            work_status: "in_delivery",
                        },
                    }
                );

                res.send({ message: "Rider assigned" });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to assign rider" });
            }
        });

        app.get('/rider/parcels', verifyFBToken, async (req, res) => {
            try {
                const email = req.query.email;

                if (!email) {
                    return res.status(400).send({ message: 'Rider email is required' });
                }

                const query = {
                    assigned_rider_email: email,
                    delivery_status: { $in: ['rider_assigned', 'in_transit'] },
                };

                const options = {
                    sort: { creation_date: -1 }, // Newest first
                };

                const parcels = await parcelCollection.find(query, options).toArray();
                res.send(parcels);
            } catch (error) {
                console.error('Error fetching rider tasks:', error);
                res.status(500).send({ message: 'Failed to get rider tasks' });
            }
        });

        // Get Parcel by ID
        app.get('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: 'Invalid Parcel ID' });
                }

                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });

                if (!parcel) {
                    return res.status(404).send({ message: 'Parcel not found' });
                }

                res.send(parcel);
            } catch (error) {
                console.error('Error fetching parcel by ID:', error);
                res.status(500).send({ message: 'Internal server error' });
            }
        });

        // Create New Parcel
        app.post('/parcels', async (req, res) => {
            try {
                const newParcel = req.body;
                const result = await parcelCollection.insertOne(newParcel);
                res.status(201).send(result);
            } catch (error) {
                console.error('Error inserting parcel:', error);
                res.status(500).send({ message: 'Failed to create parcel' });
            }
        });

        // Delete Parcel by ID
        app.delete('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: 'Invalid ID format' });
                }

                const result = await parcelCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(404).send({ message: 'Parcel not found' });
                }

                res.send({ message: 'Parcel deleted successfully' });
            } catch (error) {
                console.error('Error deleting parcel:', error);
                res.status(500).send({ message: 'Failed to delete parcel' });
            }
        });

        app.get('/payments', verifyFBToken, async (req, res) => {
            try {
                const userEmail = req.query.email;

                const query = userEmail ? { email: userEmail } : {};
                const options = { sort: { paid_at: -1 } }; // Latest first

                const payments = await paymentsCollection.find(query, options).toArray();
                res.send(payments);
            } catch (error) {
                console.error('Error fetching payment history:', error);
                res.status(500).send({ message: 'Failed to get payments' });
            }
        });


        app.post('/payments', async (req, res) => {
            try {
                const { parcelId, email, amount, paymentMethod, transactionId } = req.body;


                const updateResult = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            payment_status: 'paid'
                        }
                    }
                );

                if (updateResult.modifiedCount === 0) {
                    return res.status(404).send({ message: 'Parcel not found or already paid' });
                }

                // 2. Insert payment record
                const paymentDoc = {
                    parcelId,
                    email,
                    amount,
                    paymentMethod,
                    transactionId,
                    paid_at_string: new Date().toISOString(),
                    paid_at: new Date(),
                };

                const paymentResult = await paymentsCollection.insertOne(paymentDoc);

                res.status(201).send({
                    message: 'Payment recorded and parcel marked as paid',
                    insertedId: paymentResult.insertedId,
                });

            } catch (error) {
                console.error('Payment processing failed:', error);
                res.status(500).send({ message: 'Failed to record payment' });
            }
        });

        // dashboard apis
        app.get('/parcels/delivery/status-count', async (req, res) => {
            const pipeline = [
                {
                    $group: {
                        _id: '$delivery_status',
                        count: {
                            $sum: 1
                        }
                    }
                },
                {
                    $project: {
                        status: '$_id',
                        count: 1,
                        _id: 0
                    }
                }
            ];

            const result = await parcelCollection.aggregate(pipeline).toArray();
            res.send(result);
        })

        // rider dashboard
        app.get('/rider/dashboard', async (req, res) => {
            try {
                const riderId = req.riderId || 'demoRiderId';

                // Aggregate pending, completed counts + total earnings
                const pipeline = [
                    { $match: { rider_id: riderId } },
                    {
                        $group: {
                            _id: '$delivery_status',
                            count: { $sum: 1 },
                            totalEarnings: { $sum: '$delivery_fee' }
                        },
                    },
                    {
                        $project: {
                            status: '$_id',
                            count: 1,
                            totalEarnings: 1,
                            _id: 0,
                        },
                    },
                ];

                const results = await parcelCollection.aggregate(pipeline).toArray();

                let pending = 0;
                let completed = 0;
                let earnings = 0;

                results.forEach(({ status, count, totalEarnings }) => {
                    if (status === 'pending') pending = count;
                    if (status === 'delivered') completed = count;
                    if (totalEarnings) earnings += totalEarnings;
                });

                res.json({ pending, completed, earnings });
            } catch (error) {
                console.error(error);
                res.status(500).json({ message: 'Internal server error' });
            }
        });

        // user dashboard


        // traking related apis

        app.post("/trackings", async (req, res) => {
            const update = req.body;

            update.timestamp = new Date(); // ensure correct timestamp
            if (!update.tracking_id || !update.status) {
                return res.status(400).json({ message: "tracking_id and status are required." });
            }

            const result = await trackingsCollection.insertOne(update);
            res.status(201).json(result);
        });

        app.get("/trackings/:trackingId", async (req, res) => {
            const trackingId = req.params.trackingId;

            const updates = await trackingsCollection
                .find({ tracking_id: trackingId })
                .sort({ timestamp: 1 }) // sort by time ascending
                .toArray();

            res.json(updates);
        });
        // API: Get parcel + tracking updates by tracking code
        app.get('/trackings/:code', verifyFBToken, async (req, res) => {
            try {
                const trackingCode = req.params.code;
                if (!trackingCode) {
                    return res.status(400).json({ error: 'Tracking code is required' });
                }

                const parcel = await parcelCollection.findOne({ trackingCode });

                if (!parcel) {
                    return res.status(404).json({ error: 'Consignment not found' });
                }

                const productDetails = {
                    date: parcel.date || 'N/A',
                    id: parcel._id.toString(),
                    invoice: parcel.invoice || 'N/A',
                    trackingCode: parcel.trackingCode,
                    name: parcel.customerName || 'N/A',
                    address: parcel.customerAddress || 'N/A',
                    phone: parcel.customerPhone || 'N/A',
                    approved: parcel.approved || 'Pending',
                    weight: parcel.weight || 'N/A',
                    cod: parcel.cod || 0,
                    status: parcel.status || 'Unknown',
                };

                // Change this according to your schema
                const trackingUpdates = await trackingsCollection
                    .find({ trackingCode })  // or { tracking_id: parcel._id.toString() }
                    .sort({ timestamp: 1 })
                    .toArray();

                const formattedUpdates = trackingUpdates.map((update) => ({
                    date: update.timestamp ? new Date(update.timestamp).toLocaleString() : 'N/A',
                    status: update.status || 'Update info not available',
                }));

                res.json({ productDetails, trackingUpdates: formattedUpdates });
            } catch (error) {
                console.error('Error fetching tracking data:', error);
                res.status(500).json({ error: 'Server error' });
            }
        });



        // Stripe Payment Intent

        app.post('/create-payment-intent', async (req, res) => {
            const amountInCents = req.body.amountInCents
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents, // Amount in cents
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }

        });

        // await client.db("admin").command({ ping: 1 });
        // console.log(" Connected to MongoDB!");
    } catch (err) {
        // console.error(" MongoDB connection error:", err);
    }
}

run().catch(console.dir);

// Base Route
app.get('/', (req, res) => {
    res.send('Hello from Profast Server!');
});

// Start Server
app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});
