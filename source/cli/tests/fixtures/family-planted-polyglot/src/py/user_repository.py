class UserRepository:
    def __init__(self):
        self.rows = []

    def add(self, value):
        self.rows.append("user:" + value)

    def find_first(self):
        return self.rows[0]
