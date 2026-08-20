const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db.js");

// ==================== MIDDLEWARE ====================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Access denied. No token provided." });
    }

    jwt.verify(token, process.env.JWT_SECRET || "your_secret_key", (err, user) => {
        if (err) {
            return res.status(403).json({ error: "Invalid or expired token." });
        }
        req.user = user;
        next();
    });
};

// ==================== HELPER FUNCTIONS ====================
const parseMonthStart = (monthStr) => {
    const date = new Date(monthStr);
    if (isNaN(date.getTime())) {
        throw new Error("Invalid date format. Use '1 Jan 2026'");
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
};

const formatMonthDisplay = (dateStr) => {
    const date = new Date(dateStr);
    const day = date.getDate();
    const month = date.toLocaleString('default', { month: 'short' });
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
};

const getCurrentMonthStart = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
};

const formatDate = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const getDaysDifference = (date1, date2) => {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    d1.setHours(0, 0, 0, 0);
    d2.setHours(0, 0, 0, 0);
    const diffTime = d2 - d1;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

const determinePaymentStatus = (payment) => {
    // If status is explicitly set, return it (manual override)
    if (payment.status === 'received' || payment.status === 'lost') {
        return payment.status;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const paymentDate = new Date(payment.payment_date);
    paymentDate.setHours(0, 0, 0, 0);

    // If payment date is in the past and not received, it's overdue
    if (paymentDate < today && payment.status !== 'received') {
        return 'overdue';
    }

    return payment.status || 'pending';
};

// ==================== PAYMENT APIs ====================

// GET - All payments for a month
router.get("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month || formatMonthDisplay(getCurrentMonthStart());

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const query = `
            SELECT 
                id,
                person_name,
                amount,
                category,
                payment_date,
                status,
                received_at,
                notes,
                created_at,
                updated_at
            FROM personal_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
            ORDER BY payment_date DESC, created_at DESC
        `;

        const result = await db.query(query, [userId, monthStart]);

        const processedPayments = result.rows.map(payment => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const paymentDate = new Date(payment.payment_date);
            paymentDate.setHours(0, 0, 0, 0);
            
            const actualStatus = determinePaymentStatus(payment);
            
            let daysLate = 0;
            let isLate = false;
            
            if (actualStatus === 'pending') {
                const diff = getDaysDifference(payment.payment_date, today.toISOString().split('T')[0]);
                if (diff > 0) {
                    daysLate = diff;
                    isLate = true;
                }
            } else if (actualStatus === 'received' && payment.received_at) {
                const receivedDate = new Date(payment.received_at);
                receivedDate.setHours(0, 0, 0, 0);
                daysLate = getDaysDifference(payment.payment_date, receivedDate.toISOString().split('T')[0]);
                if (daysLate > 0) isLate = true;
            } else if (actualStatus === 'overdue') {
                const diff = getDaysDifference(payment.payment_date, today.toISOString().split('T')[0]);
                daysLate = diff > 0 ? diff : 0;
                isLate = true;
            }
            
            const date = new Date(payment.payment_date);
            const formattedDate = `${date.getDate()} ${date.toLocaleString('default', { month: 'short' })} ${date.getFullYear()}`;
            
            let formattedReceivedDate = null;
            if (payment.received_at) {
                const recDate = new Date(payment.received_at);
                formattedReceivedDate = `${recDate.getDate()} ${recDate.toLocaleString('default', { month: 'short' })} ${recDate.getFullYear()}`;
            }
            
            let daysToReceive = null;
            if (payment.status === 'received' && payment.received_at) {
                const receivedDate = new Date(payment.received_at);
                receivedDate.setHours(0, 0, 0, 0);
                daysToReceive = getDaysDifference(payment.payment_date, receivedDate.toISOString().split('T')[0]);
            }
            
            return {
                ...payment,
                amount: parseFloat(payment.amount),
                actual_status: actualStatus,
                formatted_date: formattedDate,
                formatted_received_date: formattedReceivedDate,
                days_late: daysLate,
                is_late: isLate,
                days_to_receive: daysToReceive,
                delay_message: isLate ? `${daysLate} days late` : 'On time'
            };
        });

        const statusTotals = {
            total_received: 0,
            total_pending: 0,
            total_overdue: 0,
            total_lost: 0,
            total_amount: 0
        };

        processedPayments.forEach(p => {
            statusTotals.total_amount += p.amount;
            if (p.actual_status === 'received') {
                statusTotals.total_received += p.amount;
            } else if (p.actual_status === 'pending') {
                statusTotals.total_pending += p.amount;
            } else if (p.actual_status === 'overdue') {
                statusTotals.total_overdue += p.amount;
            } else if (p.actual_status === 'lost') {
                statusTotals.total_lost += p.amount;
            }
        });

        const categoryTotals = {};
        processedPayments.forEach(p => {
            if (!categoryTotals[p.category]) {
                categoryTotals[p.category] = {
                    total: 0,
                    count: 0,
                    received: 0,
                    pending: 0,
                    overdue: 0,
                    lost: 0
                };
            }
            categoryTotals[p.category].total += p.amount;
            categoryTotals[p.category].count += 1;
            if (p.actual_status === 'received') {
                categoryTotals[p.category].received += p.amount;
            } else if (p.actual_status === 'pending') {
                categoryTotals[p.category].pending += p.amount;
            } else if (p.actual_status === 'overdue') {
                categoryTotals[p.category].overdue += p.amount;
            } else if (p.actual_status === 'lost') {
                categoryTotals[p.category].lost += p.amount;
            }
        });

        const categoryTotalsArray = Object.keys(categoryTotals).map(key => ({
            category: key,
            ...categoryTotals[key],
            total: parseFloat(categoryTotals[key].total.toFixed(2))
        }));

        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                payments: processedPayments,
                status_totals: {
                    total_received: parseFloat(statusTotals.total_received.toFixed(2)),
                    total_pending: parseFloat(statusTotals.total_pending.toFixed(2)),
                    total_overdue: parseFloat(statusTotals.total_overdue.toFixed(2)),
                    total_lost: parseFloat(statusTotals.total_lost.toFixed(2)),
                    total_amount: parseFloat(statusTotals.total_amount.toFixed(2))
                },
                category_totals: categoryTotalsArray,
                count: processedPayments.length
            }
        });

    } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET - Payment by ID
router.get("/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const paymentId = req.params.id;

        const query = `
            SELECT 
                id,
                person_name,
                amount,
                category,
                payment_date,
                status,
                received_at,
                notes,
                created_at,
                updated_at
            FROM personal_payments
            WHERE id = $1 AND user_id = $2
        `;

        const result = await db.query(query, [paymentId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Payment not found" });
        }

        const payment = result.rows[0];
        const actualStatus = determinePaymentStatus(payment);
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let daysLate = 0;
        let isLate = false;
        
        if (actualStatus === 'pending') {
            const diff = getDaysDifference(payment.payment_date, today.toISOString().split('T')[0]);
            if (diff > 0) {
                daysLate = diff;
                isLate = true;
            }
        } else if (actualStatus === 'received' && payment.received_at) {
            const receivedDate = new Date(payment.received_at);
            receivedDate.setHours(0, 0, 0, 0);
            daysLate = getDaysDifference(payment.payment_date, receivedDate.toISOString().split('T')[0]);
            if (daysLate > 0) isLate = true;
        } else if (actualStatus === 'overdue') {
            const diff = getDaysDifference(payment.payment_date, today.toISOString().split('T')[0]);
            daysLate = diff > 0 ? diff : 0;
            isLate = true;
        }

        const date = new Date(payment.payment_date);
        const formattedDate = `${date.getDate()} ${date.toLocaleString('default', { month: 'short' })} ${date.getFullYear()}`;
        
        let formattedReceivedDate = null;
        let daysToReceive = null;
        if (payment.received_at) {
            const recDate = new Date(payment.received_at);
            formattedReceivedDate = `${recDate.getDate()} ${recDate.toLocaleString('default', { month: 'short' })} ${recDate.getFullYear()}`;
            const receivedDate = new Date(payment.received_at);
            receivedDate.setHours(0, 0, 0, 0);
            daysToReceive = getDaysDifference(payment.payment_date, receivedDate.toISOString().split('T')[0]);
        }

        res.json({
            success: true,
            data: {
                ...payment,
                amount: parseFloat(payment.amount),
                actual_status: actualStatus,
                formatted_date: formattedDate,
                formatted_received_date: formattedReceivedDate,
                days_late: daysLate,
                is_late: isLate,
                days_to_receive: daysToReceive,
                delay_message: isLate ? `${daysLate} days late` : 'On time'
            }
        });

    } catch (error) {
        console.error("Error fetching payment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST - Add payment (USER CAN SET STATUS MANUALLY)
router.post("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            person_name,
            amount,
            category,
            payment_date,
            status = 'pending',  // User can set status manually
            notes = ''
        } = req.body;

        // Validation
        if (!person_name || person_name.trim() === '') {
            return res.status(400).json({ error: "Person name is required" });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Valid amount is required" });
        }

        if (!category || !['work', 'business', 'other'].includes(category.toLowerCase())) {
            return res.status(400).json({ error: "Category must be 'work', 'business', or 'other'" });
        }

        // Validate status if provided
        const validStatuses = ['pending', 'received', 'overdue', 'lost'];
        const finalStatus = status ? status.toLowerCase() : 'pending';
        if (!validStatuses.includes(finalStatus)) {
            return res.status(400).json({ error: "Invalid status. Must be pending, received, overdue, or lost" });
        }

        const currentDate = new Date().toISOString().split('T')[0];
        const paymentDate = payment_date || currentDate;
        const formattedDate = formatDate(paymentDate);

        let receivedAt = null;
        if (finalStatus === 'received') {
            receivedAt = new Date().toISOString();
        }

        const query = `
            INSERT INTO personal_payments (
                user_id,
                person_name,
                amount,
                category,
                payment_date,
                status,
                received_at,
                notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `;

        const result = await db.query(query, [
            userId,
            person_name.trim(),
            amount,
            category.toLowerCase(),
            formattedDate,
            finalStatus,
            receivedAt,
            notes
        ]);

        const payment = result.rows[0];
        const date = new Date(payment.payment_date);
        const formattedDateDisplay = `${date.getDate()} ${date.toLocaleString('default', { month: 'short' })} ${date.getFullYear()}`;

        res.json({
            success: true,
            message: "Payment added successfully",
            data: {
                ...payment,
                amount: parseFloat(payment.amount),
                formatted_date: formattedDateDisplay,
                actual_status: finalStatus
            }
        });

    } catch (error) {
        console.error("Error adding payment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT - Update payment (USER CAN MANUALLY UPDATE STATUS AND ALL FIELDS)
router.put("/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const paymentId = req.params.id;
        const {
            person_name,
            amount,
            category,
            payment_date,
            status,
            received_at,
            notes
        } = req.body;

        // Check if payment exists
        const checkQuery = `
            SELECT id, status FROM personal_payments
            WHERE id = $1 AND user_id = $2
        `;
        const checkResult = await db.query(checkQuery, [paymentId, userId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Payment not found" });
        }

        // Build dynamic update query
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (person_name !== undefined) {
            updates.push(`person_name = $${paramCount}`);
            values.push(person_name.trim());
            paramCount++;
        }

        if (amount !== undefined) {
            if (amount <= 0) {
                return res.status(400).json({ error: "Amount must be greater than 0" });
            }
            updates.push(`amount = $${paramCount}`);
            values.push(amount);
            paramCount++;
        }

        if (category !== undefined) {
            if (!['work', 'business', 'other'].includes(category.toLowerCase())) {
                return res.status(400).json({ error: "Invalid category" });
            }
            updates.push(`category = $${paramCount}`);
            values.push(category.toLowerCase());
            paramCount++;
        }

        if (payment_date !== undefined) {
            updates.push(`payment_date = $${paramCount}`);
            values.push(formatDate(payment_date));
            paramCount++;
        }

        // MANUAL STATUS UPDATE - User can set any status
        if (status !== undefined) {
            const validStatuses = ['pending', 'received', 'overdue', 'lost'];
            const finalStatus = status.toLowerCase();
            if (!validStatuses.includes(finalStatus)) {
                return res.status(400).json({ error: "Invalid status. Must be pending, received, overdue, or lost" });
            }
            updates.push(`status = $${paramCount}`);
            values.push(finalStatus);
            paramCount++;
            
            // If status is received, set received_at to now or provided value
            if (finalStatus === 'received') {
                const receivedAtValue = received_at || new Date().toISOString();
                updates.push(`received_at = $${paramCount}`);
                values.push(receivedAtValue);
                paramCount++;
            } else if (finalStatus === 'pending' || finalStatus === 'overdue' || finalStatus === 'lost') {
                // Clear received_at if not received
                updates.push(`received_at = NULL`);
            }
        }

        if (notes !== undefined) {
            updates.push(`notes = $${paramCount}`);
            values.push(notes || null);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(paymentId, userId);

        const query = `
            UPDATE personal_payments
            SET ${updates.join(', ')}
            WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
            RETURNING *
        `;

        const result = await db.query(query, values);

        const payment = result.rows[0];
        const actualStatus = determinePaymentStatus(payment);
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let daysLate = 0;
        let isLate = false;
        
        if (actualStatus === 'pending') {
            const diff = getDaysDifference(payment.payment_date, today.toISOString().split('T')[0]);
            if (diff > 0) {
                daysLate = diff;
                isLate = true;
            }
        } else if (actualStatus === 'received' && payment.received_at) {
            const receivedDate = new Date(payment.received_at);
            receivedDate.setHours(0, 0, 0, 0);
            daysLate = getDaysDifference(payment.payment_date, receivedDate.toISOString().split('T')[0]);
            if (daysLate > 0) isLate = true;
        } else if (actualStatus === 'overdue') {
            const diff = getDaysDifference(payment.payment_date, today.toISOString().split('T')[0]);
            daysLate = diff > 0 ? diff : 0;
            isLate = true;
        }

        const date = new Date(payment.payment_date);
        const formattedDate = `${date.getDate()} ${date.toLocaleString('default', { month: 'short' })} ${date.getFullYear()}`;
        
        let formattedReceivedDate = null;
        let daysToReceive = null;
        if (payment.received_at) {
            const recDate = new Date(payment.received_at);
            formattedReceivedDate = `${recDate.getDate()} ${recDate.toLocaleString('default', { month: 'short' })} ${recDate.getFullYear()}`;
            const receivedDate = new Date(payment.received_at);
            receivedDate.setHours(0, 0, 0, 0);
            daysToReceive = getDaysDifference(payment.payment_date, receivedDate.toISOString().split('T')[0]);
        }

        res.json({
            success: true,
            message: "Payment updated successfully",
            data: {
                ...payment,
                amount: parseFloat(payment.amount),
                actual_status: actualStatus,
                formatted_date: formattedDate,
                formatted_received_date: formattedReceivedDate,
                days_late: daysLate,
                is_late: isLate,
                days_to_receive: daysToReceive,
                delay_message: isLate ? `${daysLate} days late` : 'On time'
            }
        });

    } catch (error) {
        console.error("Error updating payment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT - Mark as Received (Quick Action)
router.put("/:id/receive", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const paymentId = req.params.id;

        const checkQuery = `
            SELECT id FROM personal_payments
            WHERE id = $1 AND user_id = $2
        `;
        const checkResult = await db.query(checkQuery, [paymentId, userId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Payment not found" });
        }

        const query = `
            UPDATE personal_payments 
            SET 
                status = 'received',
                received_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2
            RETURNING id, received_at
        `;

        const result = await db.query(query, [paymentId, userId]);

        res.json({
            success: true,
            message: "Payment marked as received",
            data: {
                payment_id: paymentId,
                received_at: result.rows[0].received_at
            }
        });

    } catch (error) {
        console.error("Error marking payment as received:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT - Mark as Lost (Quick Action)
router.put("/:id/lost", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const paymentId = req.params.id;

        const checkQuery = `
            SELECT id FROM personal_payments
            WHERE id = $1 AND user_id = $2
        `;
        const checkResult = await db.query(checkQuery, [paymentId, userId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Payment not found" });
        }

        const query = `
            UPDATE personal_payments 
            SET 
                status = 'lost',
                received_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2
            RETURNING id
        `;

        await db.query(query, [paymentId, userId]);

        res.json({
            success: true,
            message: "Payment marked as lost",
            data: {
                payment_id: paymentId
            }
        });

    } catch (error) {
        console.error("Error marking payment as lost:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT - Mark as Pending (Quick Action)
router.put("/:id/pending", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const paymentId = req.params.id;

        const checkQuery = `
            SELECT id FROM personal_payments
            WHERE id = $1 AND user_id = $2
        `;
        const checkResult = await db.query(checkQuery, [paymentId, userId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Payment not found" });
        }

        const query = `
            UPDATE personal_payments 
            SET 
                status = 'pending',
                received_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2
            RETURNING id
        `;

        await db.query(query, [paymentId, userId]);

        res.json({
            success: true,
            message: "Payment marked as pending",
            data: {
                payment_id: paymentId
            }
        });

    } catch (error) {
        console.error("Error marking payment as pending:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE - Delete payment
router.delete("/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const paymentId = req.params.id;

        const query = `
            DELETE FROM personal_payments
            WHERE id = $1 AND user_id = $2
            RETURNING id
        `;

        const result = await db.query(query, [paymentId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Payment not found" });
        }

        res.json({
            success: true,
            message: "Payment deleted successfully",
            data: {
                payment_id: paymentId
            }
        });

    } catch (error) {
        console.error("Error deleting payment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET - Totals for a month
router.get("/totals", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month || formatMonthDisplay(getCurrentMonthStart());

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN status = 'received' THEN amount ELSE 0 END), 0) as total_received,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as total_pending,
                COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount ELSE 0 END), 0) as total_overdue,
                COALESCE(SUM(CASE WHEN status = 'lost' THEN amount ELSE 0 END), 0) as total_lost,
                COALESCE(SUM(amount), 0) as total_amount
            FROM personal_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;

        const result = await db.query(query, [userId, monthStart]);

        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                totals: {
                    total_received: parseFloat(result.rows[0].total_received),
                    total_pending: parseFloat(result.rows[0].total_pending),
                    total_overdue: parseFloat(result.rows[0].total_overdue),
                    total_lost: parseFloat(result.rows[0].total_lost),
                    total_amount: parseFloat(result.rows[0].total_amount)
                }
            }
        });

    } catch (error) {
        console.error("Error fetching payment totals:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET - Overview summary
router.get("/overview", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month || formatMonthDisplay(getCurrentMonthStart());

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN status = 'received' THEN amount ELSE 0 END), 0) as total_received,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as total_pending,
                COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount ELSE 0 END), 0) as total_overdue,
                COALESCE(SUM(CASE WHEN status = 'lost' THEN amount ELSE 0 END), 0) as total_lost,
                COUNT(*) as total_count
            FROM personal_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;

        const result = await db.query(query, [userId, monthStart]);

        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                total_received: parseFloat(result.rows[0].total_received),
                total_pending: parseFloat(result.rows[0].total_pending),
                total_overdue: parseFloat(result.rows[0].total_overdue),
                total_lost: parseFloat(result.rows[0].total_lost),
                total_count: parseInt(result.rows[0].total_count)
            }
        });

    } catch (error) {
        console.error("Error fetching overview summary:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;