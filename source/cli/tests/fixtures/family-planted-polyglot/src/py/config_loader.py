class ConfigLoader:
    def __init__(self):
        self.data = {}

    def load(self, name):
        if name in self.data:
            return self.data[name]
        self.data[name] = "value:" + name
        return self.data[name]
