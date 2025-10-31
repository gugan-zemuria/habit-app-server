const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase client (use service role on server to bypass RLS safely)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Per-request client that forwards the user's JWT so RLS can evaluate auth.uid()
function getDbClientWithJwt(req) {
  const token = req.headers.authorization?.replace('Bearer ', '') || '';
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          Authorization: token ? `Bearer ${token}` : undefined,
        },
      },
    }
  );
}

// Middleware
app.use(cors({
  origin: [process.env.CLIENT_URL || 'http://localhost:3000', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Add request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  if (req.method === 'POST' || req.method === 'PUT') {
    console.log('Request body:', req.body);
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Body empty?', !req.body || Object.keys(req.body).length === 0);
  }
  next();
});

// Helper function to get user from token
const getUserFromToken = async (req) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new Error('No token provided');
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) throw new Error('Invalid token');
  
  return user;
};

// Routes

// Get all habits for user
app.get('/api/habits', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    
    // Include last 14 days of completions for filtering/sorting in the client
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 14);

    const { data: habits, error } = await supabase
      .from('habits')
      .select(`
        id, user_id, name, description, category, emoji, current_streak, longest_streak, is_active, created_at, updated_at,
        completions:habit_completions(completion_date)
      `)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .eq('completions.user_id', user.id)
      .gte('completions.completion_date', startDate.toISOString().split('T')[0])
      .lte('completions.completion_date', endDate.toISOString().split('T')[0])
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(habits);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// Create new habit
app.post('/api/habits', async (req, res) => {
  try {
    console.log('POST /api/habits - Full request body:', JSON.stringify(req.body));
    
    const user = await getUserFromToken(req);
    
    // Check if req.body exists and has the required data
    if (!req.body || Object.keys(req.body).length === 0) {
      console.log('Request body validation failed:', { body: req.body, keys: Object.keys(req.body || {}) });
      return res.status(400).json({ error: 'Request body is missing or empty' });
    }
    
    const { name, description, category, emoji } = req.body;
    console.log('Extracted data:', { name, description, category, emoji });

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Habit name is required' });
    }

    const { data: habit, error } = await supabase
      .from('habits')
      .insert({
        user_id: user.id,
        name,
        description,
        category,
        emoji: emoji || '📝'
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(habit);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update habit
app.put('/api/habits/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;
    const { name, description, category, emoji } = req.body;

    const { data: habit, error } = await supabase
      .from('habits')
      .update({
        name,
        description,
        category,
        emoji,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();

    if (error) throw error;

    res.json(habit);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete habit
app.delete('/api/habits/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    const { error } = await supabase
      .from('habits')
      .update({ is_active: false })
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) throw error;

    res.json({ message: 'Habit deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Toggle habit completion
app.post('/api/habits/:id/complete', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;
    const { date } = req.body;
    
    const completionDate = date || new Date().toISOString().split('T')[0];

    // Check if already completed
    const { data: existing } = await supabase
      .from('habit_completions')
      .select('id')
      .eq('habit_id', id)
      .eq('user_id', user.id)
      .eq('completion_date', completionDate)
      .single();

    if (existing) {
      // Remove completion
      const { error } = await supabase
        .from('habit_completions')
        .delete()
        .eq('habit_id', id)
        .eq('user_id', user.id)
        .eq('completion_date', completionDate);

      if (error) throw error;

      // Update streaks
      await updateHabitStreaks(id, user.id);
      
      res.json({ completed: false, message: 'Habit unmarked' });
    } else {
      // Add completion
      const { error } = await supabase
        .from('habit_completions')
        .insert({
          habit_id: id,
          user_id: user.id,
          completion_date: completionDate
        });

      if (error) throw error;

      // Update streaks
      await updateHabitStreaks(id, user.id);
      
      res.json({ completed: true, message: 'Habit completed' });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get habit completions for last 14 days
app.get('/api/habits/:id/completions', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 14);

    const { data: completions, error } = await supabase
      .from('habit_completions')
      .select('completion_date')
      .eq('habit_id', id)
      .eq('user_id', user.id)
      .gte('completion_date', startDate.toISOString().split('T')[0])
      .lte('completion_date', endDate.toISOString().split('T')[0])
      .order('completion_date', { ascending: false });

    if (error) throw error;

    res.json(completions);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    
    // Get total habits
    const { data: habits, error: habitsError } = await supabase
      .from('habits')
      .select('id, current_streak, longest_streak')
      .eq('user_id', user.id)
      .eq('is_active', true);

    if (habitsError) throw habitsError;

    // Get today's completions
    const today = new Date().toISOString().split('T')[0];
    const { data: todayCompletions, error: completionsError } = await supabase
      .from('habit_completions')
      .select('habit_id')
      .eq('user_id', user.id)
      .eq('completion_date', today);

    if (completionsError) throw completionsError;

    const stats = {
      totalHabits: habits.length,
      completedToday: todayCompletions.length,
      completionRate: habits.length > 0 ? Math.round((todayCompletions.length / habits.length) * 100) : 0,
      longestStreak: Math.max(...habits.map(h => h.longest_streak), 0),
      activeStreaks: habits.filter(h => h.current_streak > 0).length
    };

    res.json(stats);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Helper function to update habit streaks
async function updateHabitStreaks(habitId, userId) {
  try {
    // Get all completions for this habit, ordered by date
    const { data: completions, error } = await supabase
      .from('habit_completions')
      .select('completion_date')
      .eq('habit_id', habitId)
      .eq('user_id', userId)
      .order('completion_date', { ascending: false });

    if (error) throw error;

    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;

    if (completions.length > 0) {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      // Check if completed today or yesterday for current streak
      const latestCompletion = new Date(completions[0].completion_date);
      const todayStr = today.toISOString().split('T')[0];
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (completions[0].completion_date === todayStr || completions[0].completion_date === yesterdayStr) {
        // Calculate current streak
        let checkDate = new Date(completions[0].completion_date);
        for (const completion of completions) {
          const completionDate = new Date(completion.completion_date);
          if (completionDate.toISOString().split('T')[0] === checkDate.toISOString().split('T')[0]) {
            currentStreak++;
            checkDate.setDate(checkDate.getDate() - 1);
          } else {
            break;
          }
        }
      }

      // Calculate longest streak
      let streakStart = null;
      for (const completion of completions.reverse()) {
        const completionDate = new Date(completion.completion_date);
        
        if (!streakStart) {
          streakStart = completionDate;
          tempStreak = 1;
        } else {
          const expectedDate = new Date(streakStart);
          expectedDate.setDate(expectedDate.getDate() + 1);
          
          if (completionDate.toISOString().split('T')[0] === expectedDate.toISOString().split('T')[0]) {
            tempStreak++;
            streakStart = completionDate;
          } else {
            longestStreak = Math.max(longestStreak, tempStreak);
            streakStart = completionDate;
            tempStreak = 1;
          }
        }
      }
      longestStreak = Math.max(longestStreak, tempStreak);
    }

    // Update habit with new streaks
    await supabase
      .from('habits')
      .update({
        current_streak: currentStreak,
        longest_streak: Math.max(longestStreak, currentStreak),
        updated_at: new Date().toISOString()
      })
      .eq('id', habitId)
      .eq('user_id', userId);

  } catch (error) {
    console.error('Error updating streaks:', error);
  }
}

// Get completions for a specific date
app.get('/api/completions/:date', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { date } = req.params;

    const { data: completions, error } = await supabase
      .from('habit_completions')
      .select('habit_id, habits(id, name, emoji)')
      .eq('user_id', user.id)
      .eq('completion_date', date);

    if (error) throw error;

    res.json({ 
      date, 
      completions: completions.map(c => ({
        habitId: c.habit_id,
        habit: c.habits
      }))
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get all completions for calendar view (last 3 months)
app.get('/api/calendar/completions', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    
    // Get completions for the last 3 months
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    const { data: completions, error } = await supabase
      .from('habit_completions')
      .select('completion_date, habit_id')
      .eq('user_id', user.id)
      .gte('completion_date', threeMonthsAgo.toISOString().split('T')[0])
      .order('completion_date', { ascending: false });

    if (error) throw error;

    // Group completions by date
    const completionsByDate = {};
    completions.forEach(completion => {
      const date = completion.completion_date;
      if (!completionsByDate[date]) {
        completionsByDate[date] = [];
      }
      completionsByDate[date].push(completion.habit_id);
    });

    res.json(completionsByDate);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update completions for a specific date (bulk update)
app.put('/api/completions/:date', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { date } = req.params;
    const { habitIds } = req.body;

    // First, delete existing completions for this date
    await supabase
      .from('habit_completions')
      .delete()
      .eq('user_id', user.id)
      .eq('completion_date', date);

    // Then insert new completions
    if (habitIds && habitIds.length > 0) {
      const completionsToInsert = habitIds.map(habitId => ({
        user_id: user.id,
        habit_id: habitId,
        completion_date: date
      }));

      const { error } = await supabase
        .from('habit_completions')
        .insert(completionsToInsert);

      if (error) throw error;

      // Update streaks for all affected habits
      for (const habitId of habitIds) {
        await updateHabitStreaks(habitId, user.id);
      }
    }

    res.json({ date, habitIds });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});